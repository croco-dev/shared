import { MembershipStore } from "./MembershipStore";
import {
  cloneMembershipEventIntent,
  createMembershipEventIntent,
  type MembershipEventIntent,
} from "./eventIntent";
import {
  AlreadyMemberProblem,
  MembershipIdempotencyConflictProblem,
  InvalidMembershipCommandProblem,
  LastOwnerProblem,
  MembershipNotFoundProblem,
  OwnershipTransferRequiredProblem,
  RoleHierarchyViolationProblem,
  SeatLimitExceededProblem,
} from "./problems/MembershipProblems";
import { LastOwnerCannotBeRemovedProblem } from "./problems/LastOwnerCannotBeRemovedProblem";
import type {
  Membership,
  MembershipCommand,
  MembershipCommandResult,
  MembershipCreateInput,
  MembershipOwnerMutationInput,
  MembershipOwnerMutationResult,
  MembershipOwnershipTransferInput,
  MembershipOwnershipTransferResult,
  MembershipRole,
} from "./types";

export class InMemoryMembershipStore extends MembershipStore {
  readonly eventIntentDurability = "volatile" as const;
  private readonly storage = new Map<string, Membership>();
  private readonly commandResults = new Map<
    string,
    { fingerprint: string; result: MembershipCommandResult }
  >();
  private readonly eventIntents = new Map<string, MembershipEventIntent>();
  private commandTail: Promise<void> = Promise.resolve();

  async hasExecutedCommand(idempotencyKey: string): Promise<boolean> {
    return this.commandResults.has(idempotencyKey);
  }

  async execute(command: MembershipCommand): Promise<MembershipCommandResult> {
    const previous = this.commandTail;
    let release!: () => void;
    this.commandTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.executeAtomically(command);
    } finally {
      release();
    }
  }

  private async executeAtomically(command: MembershipCommand): Promise<MembershipCommandResult> {
    this.validateCommand(command);
    const fingerprint = this.fingerprint(command);
    const existing = this.commandResults.get(command.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new MembershipIdempotencyConflictProblem(command.idempotencyKey);
      }
      return this.cloneResult(existing.result, true);
    }

    const snapshot = new Map(this.storage);
    try {
      const result = await this.applyCommand(command);
      const storedResult = this.cloneResult(result, false);
      const intent = createMembershipEventIntent(command, storedResult, new Date());
      this.commandResults.set(command.idempotencyKey, { fingerprint, result: storedResult });
      if (intent) this.eventIntents.set(intent.intentId, intent);
      return this.cloneResult(storedResult, false);
    } catch (error) {
      this.storage.clear();
      for (const [key, membership] of snapshot) this.storage.set(key, membership);
      throw error;
    }
  }

  async getPendingEventIntent(idempotencyKey: string): Promise<MembershipEventIntent | null> {
    const intent = [...this.eventIntents.values()].find(
      (candidate) => candidate.idempotencyKey === idempotencyKey,
    );
    return intent ? cloneMembershipEventIntent(intent) : null;
  }

  async listPendingEventIntents(limit = 100): Promise<readonly MembershipEventIntent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new InvalidMembershipCommandProblem("event intent limit must be between 1 and 1000");
    }
    return [...this.eventIntents.values()].slice(0, limit).map(cloneMembershipEventIntent);
  }

  async markEventIntentPublished(intentId: string): Promise<void> {
    this.eventIntents.delete(intentId);
  }

  async findByTenantAndUser(tenantId: string, userId: string): Promise<Membership | null> {
    const key = this.getKey(tenantId, userId);
    return this.storage.get(key) ?? null;
  }

  async findAllByTenant(tenantId: string): Promise<Membership[]> {
    return [...this.storage.values()].filter((membership) => membership.tenantId === tenantId);
  }

  async findAllByUser(userId: string): Promise<Membership[]> {
    return [...this.storage.values()].filter((membership) => membership.userId === userId);
  }

  protected override async save(input: MembershipCreateInput): Promise<Membership> {
    const key = this.getKey(input.tenantId, input.userId);
    const now = new Date();
    const previous = this.storage.get(key);

    const membership: Membership = {
      id: input.id,
      tenantId: input.tenantId,
      userId: input.userId,
      role: input.role,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };

    this.storage.set(key, membership);
    return membership;
  }

  protected override async delete(tenantId: string, userId: string): Promise<void> {
    const key = this.getKey(tenantId, userId);
    this.storage.delete(key);
  }

  protected override async mutateOwner(
    input: MembershipOwnerMutationInput,
  ): Promise<MembershipOwnerMutationResult> {
    const key = this.getKey(input.tenantId, input.userId);
    const membership = this.storage.get(key);
    if (!membership) {
      return { status: "not_found" };
    }

    if (membership.role === "owner" && this.countOwners(input.tenantId) === 1) {
      return { status: "last_owner" };
    }

    if (input.operation === "remove") {
      this.storage.delete(key);
      return { status: "applied", membership };
    }

    const updated: Membership = {
      ...membership,
      role: input.role,
      updatedAt: new Date(),
    };
    this.storage.set(key, updated);
    return { status: "applied", membership: updated };
  }

  protected override async transferOwnership(
    input: MembershipOwnershipTransferInput,
  ): Promise<MembershipOwnershipTransferResult> {
    const fromKey = this.getKey(input.tenantId, input.fromUserId);
    const toKey = this.getKey(input.tenantId, input.toUserId);
    const fromMembership = this.storage.get(fromKey);
    if (!fromMembership) {
      return { status: "not_found", userId: input.fromUserId };
    }
    if (fromMembership.role !== "owner") {
      return { status: "source_not_owner" };
    }

    const toMembership = this.storage.get(toKey);
    if (!toMembership) {
      return { status: "not_found", userId: input.toUserId };
    }
    if (fromKey === toKey) {
      return {
        status: "applied",
        fromMembership,
        toMembership,
        previousToRole: toMembership.role,
      };
    }

    const now = new Date();
    const updatedFrom = { ...fromMembership, role: "admin" as const, updatedAt: now };
    const updatedTo = { ...toMembership, role: "owner" as const, updatedAt: now };
    this.storage.set(toKey, updatedTo);
    this.storage.set(fromKey, updatedFrom);

    return {
      status: "applied",
      fromMembership: updatedFrom,
      toMembership: updatedTo,
      previousToRole: toMembership.role,
    };
  }

  async countByRole(tenantId: string, role: MembershipRole): Promise<number> {
    return [...this.storage.values()].filter(
      (membership) => membership.tenantId === tenantId && membership.role === role,
    ).length;
  }

  async countAll(tenantId: string): Promise<number> {
    return [...this.storage.values()].filter((membership) => membership.tenantId === tenantId)
      .length;
  }

  private getKey(tenantId: string, userId: string): string {
    return JSON.stringify([tenantId, userId]);
  }

  private async applyCommand(command: MembershipCommand): Promise<MembershipCommandResult> {
    if (command.operation === "add") {
      const existing = await this.findByTenantAndUser(command.tenantId, command.userId);
      if (existing) throw new AlreadyMemberProblem(command.tenantId, command.userId);
      const currentSeats = await this.countAll(command.tenantId);
      if (command.maxSeats !== null && currentSeats >= command.maxSeats) {
        throw new SeatLimitExceededProblem(command.tenantId, currentSeats, command.maxSeats);
      }
      return {
        operation: "add",
        membership: await this.save({
          id: command.membershipId,
          tenantId: command.tenantId,
          userId: command.userId,
          role: command.role,
        }),
        replayed: false,
      };
    }
    if (command.operation === "remove") {
      const result = await this.mutateOwner({
        tenantId: command.tenantId,
        userId: command.userId,
        operation: "remove",
      });
      if (result.status === "not_found") {
        throw new MembershipNotFoundProblem(command.tenantId, command.userId);
      }
      if (result.status !== "applied") {
        throw new LastOwnerCannotBeRemovedProblem(command.tenantId, command.userId);
      }
      return { operation: "remove", membership: result.membership, replayed: false };
    }
    if (command.operation === "update_role") {
      const previous = await this.findByTenantAndUser(command.tenantId, command.userId);
      if (!previous) throw new MembershipNotFoundProblem(command.tenantId, command.userId);
      if (previous.role === command.role) {
        return {
          operation: "update_role",
          membership: previous,
          previousRole: previous.role,
          replayed: false,
        };
      }
      if (command.role === "owner") {
        throw new RoleHierarchyViolationProblem(previous.role, command.role, "promote");
      }
      const result = await this.applyRoleMutation(command.tenantId, command.userId, command.role);
      return {
        operation: "update_role",
        membership: result,
        previousRole: previous.role,
        replayed: false,
      };
    }
    const result = await this.transferOwnership(command);
    if (result.status === "not_found") {
      throw new MembershipNotFoundProblem(command.tenantId, result.userId);
    }
    if (result.status !== "applied") {
      throw new OwnershipTransferRequiredProblem(command.tenantId, command.fromUserId);
    }
    return { operation: "transfer_ownership", ...result, replayed: false };
  }

  private async applyRoleMutation(
    tenantId: string,
    userId: string,
    role: Exclude<MembershipRole, "owner">,
  ): Promise<Membership> {
    const result = await this.mutateOwner({ tenantId, userId, operation: "demote", role });
    if (result.status === "not_found") throw new MembershipNotFoundProblem(tenantId, userId);
    if (result.status !== "applied") throw new LastOwnerProblem(tenantId, userId, "demote");
    return result.membership;
  }

  private validateCommand(command: MembershipCommand): void {
    if (command.idempotencyKey.trim().length === 0) {
      throw new InvalidMembershipCommandProblem("idempotencyKey is required");
    }
  }

  private fingerprint(command: MembershipCommand): string {
    const semantic =
      command.operation === "add"
        ? {
            operation: command.operation,
            tenantId: command.tenantId,
            userId: command.userId,
            role: command.role,
          }
        : command;
    return JSON.stringify(semantic, Object.keys(semantic).sort());
  }

  private cloneResult(result: MembershipCommandResult, replayed: boolean): MembershipCommandResult {
    if (result.operation === "transfer_ownership") {
      return {
        ...result,
        fromMembership: { ...result.fromMembership },
        toMembership: { ...result.toMembership },
        replayed,
      };
    }
    return { ...result, membership: { ...result.membership }, replayed };
  }

  private countOwners(tenantId: string): number {
    return [...this.storage.values()].filter(
      (membership) => membership.tenantId === tenantId && membership.role === "owner",
    ).length;
  }
}
