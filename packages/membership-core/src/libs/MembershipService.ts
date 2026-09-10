import { randomUUID } from "node:crypto";
import type { DomainEvent } from "@croco/events-core";
import type { MembershipEventIntent, MembershipEventIntentEvent } from "./eventIntent";
import { MembershipCreatedEvent } from "./events/MembershipCreatedEvent";
import { MembershipRemovedEvent } from "./events/MembershipRemovedEvent";
import { MembershipUpdatedEvent } from "./events/MembershipUpdatedEvent";
import type {
  AddMembershipCommandResult,
  MembershipManager,
} from "./interfaces/AbstractMembershipManager";
import type { MembershipStore } from "./MembershipStore";
import {
  InvalidMembershipCommandProblem,
  InvalidRoleProblem,
  MembershipEventPublicationProblem,
  MembershipNotFoundProblem,
} from "./problems/MembershipProblems";
import type { SeatLimitChecker } from "./SeatLimitChecker";
import {
  isMembershipRole,
  type Membership,
  type MembershipCommand,
  type MembershipCommandResult,
  type MembershipRole,
} from "./types";

export interface MembershipEventPublisher {
  /** Implementations must deduplicate retries and concurrent deliveries by `event.eventId`. */
  publishIdempotently(event: DomainEvent): Promise<void>;
}

export type MembershipServiceOptions = {
  readonly store: MembershipStore;
  readonly eventPublisher?: MembershipEventPublisher;
  readonly seatLimitChecker?: SeatLimitChecker;
  readonly eventDelivery?: "development" | "durable";
  readonly idGenerator?: () => string;
};

export class MembershipService implements MembershipManager {
  private readonly store: MembershipStore;
  private readonly eventPublisher?: MembershipEventPublisher;
  private readonly seatLimitChecker?: SeatLimitChecker;
  private readonly idGenerator: () => string;

  constructor(options: MembershipServiceOptions) {
    this.store = options.store;
    this.eventPublisher = options.eventPublisher;
    this.seatLimitChecker = options.seatLimitChecker;
    this.idGenerator = options.idGenerator ?? randomUUID;
    if (
      (options.eventDelivery ?? "durable") === "durable" &&
      this.store.eventIntentDurability !== "persistent"
    ) {
      throw new InvalidMembershipCommandProblem(
        "durable event delivery requires persistent event intents",
      );
    }
  }

  async addMember(
    tenantId: string,
    userId: string,
    role: MembershipRole,
    idempotencyKey: string,
  ): Promise<Membership> {
    return (await this.addMemberCommand(tenantId, userId, role, idempotencyKey)).membership;
  }

  async addMemberCommand(
    tenantId: string,
    userId: string,
    role: MembershipRole,
    idempotencyKey: string,
  ): Promise<AddMembershipCommandResult> {
    this.ensureValidRole(role);
    const alreadyExecuted = await this.store.hasExecutedCommand(idempotencyKey);
    const configuredMaxSeats =
      !alreadyExecuted && this.seatLimitChecker
        ? await this.seatLimitChecker.getMaxSeats(tenantId)
        : null;
    const result = await this.execute({
      operation: "add",
      idempotencyKey,
      membershipId: this.idGenerator(),
      tenantId,
      userId,
      role,
      maxSeats: configuredMaxSeats === Number.POSITIVE_INFINITY ? null : configuredMaxSeats,
    });
    if (result.operation !== "add") {
      throw new InvalidMembershipCommandProblem(`store returned '${result.operation}' for 'add'`);
    }
    return result;
  }

  async removeMember(tenantId: string, userId: string, idempotencyKey: string): Promise<void> {
    await this.execute({ operation: "remove", idempotencyKey, tenantId, userId });
  }

  async updateRole(
    tenantId: string,
    userId: string,
    newRole: MembershipRole,
    idempotencyKey: string,
  ): Promise<Membership> {
    this.ensureValidRole(newRole);
    const result = await this.execute({
      operation: "update_role",
      idempotencyKey,
      tenantId,
      userId,
      role: newRole,
    });
    return this.requireMembershipResult(result, "update_role");
  }

  async transferOwnership(
    tenantId: string,
    fromUserId: string,
    toUserId: string,
    idempotencyKey: string,
  ): Promise<void> {
    await this.execute({
      operation: "transfer_ownership",
      idempotencyKey,
      tenantId,
      fromUserId,
      toUserId,
    });
  }

  async publishPendingEvents(limit = 100): Promise<number> {
    if (!this.eventPublisher) {
      throw new InvalidMembershipCommandProblem(
        "publishing pending events requires an idempotent event publisher",
      );
    }
    const intents = await this.store.listPendingEventIntents(limit);
    for (const intent of intents) await this.publishIntent(intent);
    return intents.length;
  }

  async getMember(tenantId: string, userId: string): Promise<Membership> {
    return this.getMembershipOrThrow(tenantId, userId);
  }

  async listMembers(tenantId: string): Promise<Membership[]> {
    return this.store.findAllByTenant(tenantId);
  }

  async listTenants(userId: string): Promise<Membership[]> {
    return this.store.findAllByUser(userId);
  }

  private async execute(command: MembershipCommand): Promise<MembershipCommandResult> {
    const result = await this.store.execute(command);
    if (result.operation !== command.operation) {
      throw new InvalidMembershipCommandProblem(
        `store returned '${result.operation}' for '${command.operation}'`,
      );
    }
    return result;
  }

  private async publishIntent(intent: MembershipEventIntent): Promise<void> {
    if (!this.eventPublisher) return;
    try {
      for (const event of intent.events) {
        await this.eventPublisher.publishIdempotently(this.restoreEvent(event));
      }
      await this.store.markEventIntentPublished(intent.intentId);
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      throw new MembershipEventPublicationProblem(intent.idempotencyKey, cause);
    }
  }

  private restoreEvent(event: MembershipEventIntentEvent): DomainEvent {
    if (event.eventName === "membership.created") {
      return new MembershipCreatedEvent(event.data, event.eventId, event.occurredAt);
    }
    if (event.eventName === "membership.removed") {
      return new MembershipRemovedEvent(event.data, event.eventId, event.occurredAt);
    }
    return new MembershipUpdatedEvent(event.data, event.eventId, event.occurredAt);
  }

  private requireMembershipResult(
    result: MembershipCommandResult,
    operation: "add" | "update_role",
  ): Membership {
    if (result.operation !== operation) {
      throw new InvalidMembershipCommandProblem(
        `store returned '${result.operation}' for '${operation}'`,
      );
    }
    return result.membership;
  }

  private async getMembershipOrThrow(tenantId: string, userId: string): Promise<Membership> {
    const membership = await this.store.findByTenantAndUser(tenantId, userId);
    if (!membership) throw new MembershipNotFoundProblem(tenantId, userId);
    return membership;
  }

  private ensureValidRole(role: string): void {
    if (!isMembershipRole(role)) throw new InvalidRoleProblem(role);
  }
}
