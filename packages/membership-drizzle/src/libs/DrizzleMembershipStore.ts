import { Component, Inject, Token } from "@croco/framework-context";
import {
  createMembershipEventIntent,
  type Membership,
  type MembershipCommand,
  type MembershipCommandResult,
  type MembershipCreateInput,
  type MembershipEventIntent,
  type MembershipOwnerMutationInput,
  type MembershipOwnerMutationResult,
  type MembershipOwnershipTransferInput,
  type MembershipOwnershipTransferResult,
  type MembershipRole,
  AlreadyMemberProblem,
  InvalidMembershipCommandProblem,
  LastOwnerProblem,
  LastOwnerCannotBeRemovedProblem,
  MembershipConstraintProblem,
  MembershipIdempotencyConflictProblem,
  MembershipNotFoundProblem,
  MembershipStore,
  OwnershipTransferRequiredProblem,
  RoleHierarchyViolationProblem,
  SeatLimitExceededProblem,
} from "@croco/membership-core";
// Runtime value required for constructor metadata.
// oxlint-disable-next-line typescript/consistent-type-imports
import { TxManager } from "@croco/tx-core";
import type { DrizzleDb } from "@croco/tx-drizzle";
import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { membershipEventIntents, membershipIdempotencyRecords, memberships } from "./schema";

type DrizzleMembershipClient = DrizzleDb & NodePgDatabase<Record<string, never>>;

type MembershipRow = typeof memberships.$inferSelect;

type RawMembershipRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  role: MembershipRole;
  created_at: Date;
  updated_at: Date;
};

/**
 * 멤버십 저장소용 Drizzle 클라이언트 주입 토큰입니다.
 */
export const DRIZZLE_TOKEN = new Token<DrizzleMembershipClient>("DRIZZLE_TOKEN");

/**
 * 멤버십 저장소에서 사용하는 Drizzle 클라이언트 타입입니다.
 */
export type { DrizzleMembershipClient };

/**
 * 멤버십 엔터티를 Drizzle로 저장하고 조회하는 구현체입니다.
 */
@Component()
export class DrizzleMembershipStore extends MembershipStore {
  readonly eventIntentDurability = "persistent" as const;
  /**
   * Drizzle 클라이언트와 트랜잭션 매니저를 받아 저장소를 초기화합니다.
   */
  constructor(
    @Inject(DRIZZLE_TOKEN) private readonly db: DrizzleMembershipClient,
    private readonly txManager: TxManager<DrizzleMembershipClient>,
  ) {
    super();
  }

  async hasExecutedCommand(idempotencyKey: string): Promise<boolean> {
    const client = this.txManager.getClient() ?? this.db;
    const rows = await client
      .select({ key: membershipIdempotencyRecords.key })
      .from(membershipIdempotencyRecords)
      .where(eq(membershipIdempotencyRecords.key, idempotencyKey))
      .limit(1);
    return rows.length > 0;
  }

  async execute(command: MembershipCommand): Promise<MembershipCommandResult> {
    if (command.idempotencyKey.trim().length === 0) {
      throw new InvalidMembershipCommandProblem("idempotencyKey is required");
    }
    const fingerprint = this.fingerprint(command);
    const joinedTransaction = this.txManager.getClient() !== null;
    try {
      return await this.txManager.run(async () => {
        const client = this.txManager.getClient() ?? this.db;
        await client.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`membership:${command.tenantId}`}, 0))`,
        );
        await client.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${command.idempotencyKey}, 0))`,
        );
        const existing = await client
          .select()
          .from(membershipIdempotencyRecords)
          .where(eq(membershipIdempotencyRecords.key, command.idempotencyKey))
          .limit(1);
        if (existing[0]) {
          if (existing[0].fingerprint !== fingerprint) {
            throw new MembershipIdempotencyConflictProblem(command.idempotencyKey);
          }
          return this.cloneResult(existing[0].result, true);
        }

        const result = await this.applyCommand(command);
        await client.insert(membershipIdempotencyRecords).values({
          key: command.idempotencyKey,
          fingerprint,
          result,
        });
        const intent = createMembershipEventIntent(command, result, new Date());
        if (intent) {
          await client.insert(membershipEventIntents).values({
            intentId: intent.intentId,
            idempotencyKey: intent.idempotencyKey,
            events: intent.events,
          });
        }
        return this.cloneResult(result, false);
      });
    } catch (error) {
      if (command.operation === "add" && this.isSeatClaimConflict(error)) {
        return this.classifyCommittedAdd(command, fingerprint, joinedTransaction);
      }
      throw error;
    }
  }

  async getPendingEventIntent(idempotencyKey: string): Promise<MembershipEventIntent | null> {
    const client = this.txManager.getClient() ?? this.db;
    const rows = await client
      .select()
      .from(membershipEventIntents)
      .where(
        and(
          eq(membershipEventIntents.idempotencyKey, idempotencyKey),
          isNull(membershipEventIntents.publishedAt),
        ),
      )
      .limit(1);
    return rows[0] ? this.mapIntent(rows[0]) : null;
  }

  async listPendingEventIntents(limit = 100): Promise<readonly MembershipEventIntent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new InvalidMembershipCommandProblem("event intent limit must be between 1 and 1000");
    }
    const client = this.txManager.getClient() ?? this.db;
    const rows = await client
      .select()
      .from(membershipEventIntents)
      .where(isNull(membershipEventIntents.publishedAt))
      .orderBy(asc(membershipEventIntents.createdAt), asc(membershipEventIntents.intentId))
      .limit(limit);
    return rows.map((row) => this.mapIntent(row));
  }

  async markEventIntentPublished(intentId: string): Promise<void> {
    const client = this.txManager.getClient() ?? this.db;
    await client
      .update(membershipEventIntents)
      .set({ publishedAt: new Date() })
      .where(
        and(
          eq(membershipEventIntents.intentId, intentId),
          isNull(membershipEventIntents.publishedAt),
        ),
      );
  }

  /**
   * 테넌트와 사용자 조합으로 멤버십을 조회합니다.
   */
  async findByTenantAndUser(tenantId: string, userId: string): Promise<Membership | null> {
    const client = this.txManager.getClient() ?? this.db;

    const rows = (await client
      .select()
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
      .limit(1)) as MembershipRow[];

    if (rows.length === 0) {
      return null;
    }

    return this.mapToMembership(rows[0]);
  }

  /**
   * 테넌트의 모든 멤버십을 조회합니다.
   */
  async findAllByTenant(tenantId: string): Promise<Membership[]> {
    const client = this.txManager.getClient() ?? this.db;

    const rows = (await client
      .select()
      .from(memberships)
      .where(eq(memberships.tenantId, tenantId))) as MembershipRow[];
    return rows.map((row) => this.mapToMembership(row));
  }

  /**
   * 사용자의 모든 멤버십을 조회합니다.
   */
  async findAllByUser(userId: string): Promise<Membership[]> {
    const client = this.txManager.getClient() ?? this.db;

    const rows = (await client
      .select()
      .from(memberships)
      .where(eq(memberships.userId, userId))) as MembershipRow[];
    return rows.map((row) => this.mapToMembership(row));
  }

  /**
   * 멤버십을 upsert 방식으로 저장합니다.
   */
  protected override async save(input: MembershipCreateInput): Promise<Membership> {
    const client = this.txManager.getClient() ?? this.db;

    const rows = (await client
      .insert(memberships)
      .values({
        id: input.id,
        tenantId: input.tenantId,
        userId: input.userId,
        role: input.role,
      })
      .onConflictDoUpdate({
        target: [memberships.tenantId, memberships.userId],
        set: {
          id: input.id,
          role: input.role,
          updatedAt: new Date(),
        },
      })
      .returning()) as MembershipRow[];

    return this.mapToMembership(rows[0]);
  }

  /**
   * 테넌트와 사용자 조합의 멤버십을 삭제합니다.
   */
  protected override async delete(tenantId: string, userId: string): Promise<void> {
    const client = this.txManager.getClient() ?? this.db;

    await client
      .delete(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)));
  }

  /**
   * 현재 소유자 행을 잠근 뒤 조건부 변경으로 마지막 소유자 제약을 확인하고 제거 또는 강등합니다.
   */
  protected override async mutateOwner(
    input: MembershipOwnerMutationInput,
  ): Promise<MembershipOwnerMutationResult> {
    try {
      return await this.txManager.run(async () => {
        const client = this.txManager.getClient() ?? this.db;

        await client
          .select({ userId: memberships.userId })
          .from(memberships)
          .where(and(eq(memberships.tenantId, input.tenantId), eq(memberships.role, "owner")))
          .for("update");

        const canMutate = and(
          eq(memberships.tenantId, input.tenantId),
          eq(memberships.userId, input.userId),
          sql`(
            ${memberships.role} <> 'owner'
            or exists (
              select 1
              from ${memberships} as other_owner
              where other_owner.tenant_id = ${input.tenantId}
                and other_owner.role = 'owner'
                and other_owner.user_id <> ${input.userId}
            )
          )`,
        );

        let mutatedRows: MembershipRow[];
        if (input.operation === "remove") {
          mutatedRows = (await client
            .delete(memberships)
            .where(canMutate)
            .returning()) as MembershipRow[];
        } else {
          mutatedRows = (await client
            .update(memberships)
            .set({ role: input.role, updatedAt: new Date() })
            .where(canMutate)
            .returning()) as MembershipRow[];
        }

        const mutated = mutatedRows[0];
        if (mutated) {
          return { status: "applied", membership: this.mapToMembership(mutated) };
        }

        const rows = (await client
          .select()
          .from(memberships)
          .where(
            and(eq(memberships.tenantId, input.tenantId), eq(memberships.userId, input.userId)),
          )
          .limit(1)) as MembershipRow[];

        return rows[0] ? { status: "last_owner" } : { status: "not_found" };
      });
    } catch (error) {
      if (this.isSerializationFailure(error)) {
        return { status: "conflict" };
      }
      throw error;
    }
  }

  /**
   * 두 멤버십의 역할을 하나의 조건부 UPDATE로 변경하여 소유권을 이전합니다.
   */
  protected override async transferOwnership(
    input: MembershipOwnershipTransferInput,
  ): Promise<MembershipOwnershipTransferResult> {
    try {
      return await this.txManager.run(async () => {
        const client = this.txManager.getClient() ?? this.db;

        await client
          .select({ userId: memberships.userId })
          .from(memberships)
          .where(and(eq(memberships.tenantId, input.tenantId), eq(memberships.role, "owner")))
          .for("update");

        const existingRows = (await client
          .select()
          .from(memberships)
          .where(
            and(
              eq(memberships.tenantId, input.tenantId),
              inArray(memberships.userId, [input.fromUserId, input.toUserId]),
            ),
          )) as MembershipRow[];
        const fromMembership = existingRows.find((row) => row.userId === input.fromUserId);
        const toMembership = existingRows.find((row) => row.userId === input.toUserId);

        if (!fromMembership) {
          return { status: "not_found", userId: input.fromUserId };
        }
        if (fromMembership.role !== "owner") {
          return { status: "source_not_owner" };
        }
        if (!toMembership) {
          return { status: "not_found", userId: input.toUserId };
        }
        if (input.fromUserId === input.toUserId) {
          const membership = this.mapToMembership(fromMembership);
          return {
            status: "applied",
            fromMembership: membership,
            toMembership: membership,
            previousToRole: membership.role,
          };
        }

        const updatedRows = (await client
          .update(memberships)
          .set({
            role: sql<MembershipRole>`case
            when ${memberships.userId} = ${input.fromUserId} then 'admin'
            else 'owner'
          end`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(memberships.tenantId, input.tenantId),
              inArray(memberships.userId, [input.fromUserId, input.toUserId]),
              sql`(
              select source_owner.role
              from ${memberships} as source_owner
              where source_owner.tenant_id = ${input.tenantId}
                and source_owner.user_id = ${input.fromUserId}
            ) = 'owner'`,
              sql`(
              select count(*)
              from ${memberships} as transfer_member
              where transfer_member.tenant_id = ${input.tenantId}
                and transfer_member.user_id in (${input.fromUserId}, ${input.toUserId})
            ) = 2`,
            ),
          )
          .returning()) as MembershipRow[];
        const updatedFrom = updatedRows.find((row) => row.userId === input.fromUserId);
        const updatedTo = updatedRows.find((row) => row.userId === input.toUserId);

        if (!updatedFrom || !updatedTo) {
          const currentRows = (await client
            .select()
            .from(memberships)
            .where(
              and(
                eq(memberships.tenantId, input.tenantId),
                inArray(memberships.userId, [input.fromUserId, input.toUserId]),
              ),
            )) as MembershipRow[];
          const currentFrom = currentRows.find((row) => row.userId === input.fromUserId);
          const currentTo = currentRows.find((row) => row.userId === input.toUserId);
          if (!currentFrom) {
            return { status: "not_found", userId: input.fromUserId };
          }
          if (!currentTo) {
            return { status: "not_found", userId: input.toUserId };
          }
          return { status: "source_not_owner" };
        }

        return {
          status: "applied",
          fromMembership: this.mapToMembership(updatedFrom),
          toMembership: this.mapToMembership(updatedTo),
          previousToRole: toMembership.role,
        };
      });
    } catch (error) {
      if (this.isSerializationFailure(error)) {
        return { status: "conflict" };
      }
      throw error;
    }
  }

  /**
   * 특정 역할의 멤버 수를 반환합니다.
   */
  async countByRole(tenantId: string, role: MembershipRole): Promise<number> {
    const client = this.txManager.getClient() ?? this.db;

    const rows = (await client
      .select({ total: count() })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.role, role)))) as {
      total: number;
    }[];

    return Number(rows[0]?.total ?? 0);
  }

  /**
   * 테넌트의 전체 멤버 수를 반환합니다.
   */
  async countAll(tenantId: string): Promise<number> {
    const client = this.txManager.getClient() ?? this.db;

    const rows = (await client
      .select({ total: count() })
      .from(memberships)
      .where(eq(memberships.tenantId, tenantId))) as { total: number }[];

    return Number(rows[0]?.total ?? 0);
  }

  private mapToMembership(row: MembershipRow): Membership {
    return {
      id: row.id,
      tenantId: row.tenantId,
      userId: row.userId,
      role: row.role,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async applyCommand(command: MembershipCommand): Promise<MembershipCommandResult> {
    if (command.operation === "add") {
      const existing = await this.findByTenantAndUser(command.tenantId, command.userId);
      if (existing) throw new AlreadyMemberProblem(command.tenantId, command.userId);
      const membership = await this.insertWithinSeatLimit(command);
      return {
        operation: "add",
        membership,
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
      const result = await this.mutateOwner({
        tenantId: command.tenantId,
        userId: command.userId,
        operation: "demote",
        role: command.role,
      });
      if (result.status === "not_found") {
        throw new MembershipNotFoundProblem(command.tenantId, command.userId);
      }
      if (result.status !== "applied") {
        throw new LastOwnerProblem(command.tenantId, command.userId, "demote");
      }
      return {
        operation: "update_role",
        membership: result.membership,
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

  private mapIntent(row: typeof membershipEventIntents.$inferSelect): MembershipEventIntent {
    return {
      intentId: row.intentId,
      idempotencyKey: row.idempotencyKey,
      events: row.events.map((event) => ({
        ...event,
        occurredAt: new Date(event.occurredAt),
        data: { ...event.data },
      })) as readonly MembershipEventIntent["events"][number][],
    };
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
        fromMembership: this.cloneMembership(result.fromMembership),
        toMembership: this.cloneMembership(result.toMembership),
        replayed,
      };
    }
    return { ...result, membership: this.cloneMembership(result.membership), replayed };
  }

  private cloneMembership(membership: Membership): Membership {
    return {
      ...membership,
      createdAt: new Date(membership.createdAt),
      updatedAt: new Date(membership.updatedAt),
    };
  }

  private async insertWithinSeatLimit(
    command: Extract<MembershipCommand, { operation: "add" }>,
  ): Promise<Membership> {
    if (command.maxSeats === null) {
      const client = this.txManager.getClient() ?? this.db;
      const rows = (await client
        .insert(memberships)
        .values({
          id: command.membershipId,
          tenantId: command.tenantId,
          userId: command.userId,
          role: command.role,
        })
        .onConflictDoNothing({ target: [memberships.tenantId, memberships.userId] })
        .returning()) as MembershipRow[];
      if (rows[0]) return this.mapToMembership(rows[0]);
      const duplicate = await this.findByTenantAndUser(command.tenantId, command.userId);
      if (duplicate) throw new AlreadyMemberProblem(command.tenantId, command.userId);
      throw new MembershipConstraintProblem("Membership creation conflicted; retry the request", {
        tenantId: command.tenantId,
        userId: command.userId,
      });
    }

    const client = this.txManager.getClient() ?? this.db;
    const result = (await client.execute(sql`
      with candidate as (
        select slot
        from generate_series(1, ${command.maxSeats}) as slot
        where (
          select count(*)
          from ${memberships}
          where ${memberships.tenantId} = ${command.tenantId}
        ) < ${command.maxSeats}
          and not exists (
            select 1
            from ${memberships} as claimed_seat
            where claimed_seat.tenant_id = ${command.tenantId}
              and claimed_seat.seat_ordinal = slot
          )
        order by slot
        limit 1
      )
      insert into ${memberships} (id, tenant_id, user_id, role, seat_ordinal)
      select ${command.membershipId}, ${command.tenantId}, ${command.userId}, ${command.role}, slot
      from candidate
      on conflict do nothing
      returning id, tenant_id, user_id, role, created_at, updated_at
    `)) as unknown as { rows: RawMembershipRow[] };
    const row = result.rows[0];
    if (row) return this.mapRawToMembership(row);

    const duplicate = await this.findByTenantAndUser(command.tenantId, command.userId);
    if (duplicate) throw new AlreadyMemberProblem(command.tenantId, command.userId);
    const currentSeats = await this.countAll(command.tenantId);
    if (currentSeats >= command.maxSeats) {
      throw new SeatLimitExceededProblem(command.tenantId, currentSeats, command.maxSeats);
    }
    throw new MembershipConstraintProblem("Membership creation conflicted; retry the request", {
      tenantId: command.tenantId,
      userId: command.userId,
    });
  }

  private mapRawToMembership(row: RawMembershipRow): Membership {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      role: row.role,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private isSeatClaimConflict(error: unknown): boolean {
    if (this.isSerializationFailure(error)) return true;
    if (typeof error !== "object" || error === null) return false;
    if (
      "code" in error &&
      (error as { code?: unknown }).code === "23505" &&
      "constraint" in error &&
      (error as { constraint?: unknown }).constraint === "memberships_tenant_id_seat_ordinal_unique"
    ) {
      return true;
    }
    return "cause" in error && this.isSeatClaimConflict((error as { cause?: unknown }).cause);
  }

  private async classifyCommittedAdd(
    command: Extract<MembershipCommand, { operation: "add" }>,
    fingerprint: string,
    joinedTransaction: boolean,
  ): Promise<MembershipCommandResult> {
    const records = await this.db
      .select()
      .from(membershipIdempotencyRecords)
      .where(eq(membershipIdempotencyRecords.key, command.idempotencyKey))
      .limit(1);
    const record = records[0];
    if (record) {
      if (record.fingerprint !== fingerprint) {
        throw new MembershipIdempotencyConflictProblem(command.idempotencyKey);
      }
      if (!joinedTransaction) {
        return this.cloneResult(record.result, true);
      }
      throw new MembershipConstraintProblem("Membership creation conflicted; retry the request", {
        tenantId: command.tenantId,
        userId: command.userId,
      });
    }

    const duplicate = await this.findCommittedByTenantAndUser(command.tenantId, command.userId);
    if (duplicate) throw new AlreadyMemberProblem(command.tenantId, command.userId);
    if (command.maxSeats !== null) {
      const currentSeats = await this.countCommitted(command.tenantId);
      if (currentSeats >= command.maxSeats) {
        throw new SeatLimitExceededProblem(command.tenantId, currentSeats, command.maxSeats);
      }
    }
    throw new MembershipConstraintProblem("Membership creation conflicted; retry the request", {
      tenantId: command.tenantId,
      userId: command.userId,
    });
  }

  private async findCommittedByTenantAndUser(
    tenantId: string,
    userId: string,
  ): Promise<Membership | null> {
    const rows = (await this.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
      .limit(1)) as MembershipRow[];
    return rows[0] ? this.mapToMembership(rows[0]) : null;
  }

  private async countCommitted(tenantId: string): Promise<number> {
    const rows = (await this.db
      .select({ total: count() })
      .from(memberships)
      .where(eq(memberships.tenantId, tenantId))) as { total: number }[];
    return Number(rows[0]?.total ?? 0);
  }

  private isSerializationFailure(error: unknown): boolean {
    if (typeof error !== "object" || error === null) {
      return false;
    }
    if ("code" in error && (error as { code?: unknown }).code === "40001") {
      return true;
    }
    return "cause" in error && this.isSerializationFailure((error as { cause?: unknown }).cause);
  }
}
