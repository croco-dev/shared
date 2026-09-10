import { Component, Inject, Token } from "@croco/framework-context";
import { DomainAutoJoinRecoveryProblem, DomainPolicyStore } from "@croco/invitation-core";
import type {
  DomainAutoJoinEventStatus,
  DomainAutoJoinIntent,
  DomainAutoJoinIntentCreation,
  DomainAutoJoinIntentInput,
  DomainPolicy,
} from "@croco/invitation-core";
// Runtime value required for constructor metadata.
// oxlint-disable-next-line typescript/consistent-type-imports
import { TxManager } from "@croco/tx-core";
import type { DrizzleDb } from "@croco/tx-drizzle";
import { and, eq, isNotNull, isNull, lte, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { domainAutoJoinIntents, domainPolicies } from "./schema";

type DrizzleDomainPolicyClient = DrizzleDb & NodePgDatabase<Record<string, never>>;

interface DomainPolicyRow {
  id: string;
  tenantId: string;
  domain: string;
  role: "owner" | "admin" | "member" | "viewer";
  enabled: boolean;
  createdAt: Date;
}

interface DomainAutoJoinIntentRow {
  tenantId: string;
  idempotencyKey: string;
  userId: string;
  email: string;
  domain: string;
  role: "owner" | "admin" | "member" | "viewer";
  membershipId: string | null;
  membershipRole: "owner" | "admin" | "member" | "viewer" | null;
  membershipCreatedAt: Date | null;
  membershipUpdatedAt: Date | null;
  eventStatus: DomainAutoJoinEventStatus;
  eventClaimId: string | null;
  eventClaimExpiresAt: Date | null;
  eventId: string;
  eventOccurredAt: Date;
  createdAt: Date;
}

/**
 * 도메인 정책 저장소용 Drizzle 클라이언트 주입 토큰입니다.
 */
export const DRIZZLE_DOMAIN_POLICY_TOKEN = new Token<DrizzleDomainPolicyClient>(
  "DRIZZLE_DOMAIN_POLICY_TOKEN",
);

/**
 * 도메인 정책 저장소에서 사용하는 Drizzle 클라이언트 타입입니다.
 */
export type { DrizzleDomainPolicyClient };

/**
 * 도메인 정책 엔터티를 Drizzle로 저장하고 조회하는 구현체입니다.
 */
@Component()
export class DrizzleDomainPolicyStore extends DomainPolicyStore {
  /**
   * Drizzle 클라이언트와 트랜잭션 매니저를 받아 저장소를 초기화합니다.
   */
  constructor(
    @Inject(DRIZZLE_DOMAIN_POLICY_TOKEN) private readonly db: DrizzleDomainPolicyClient,
    private readonly txManager: TxManager<DrizzleDomainPolicyClient>,
  ) {
    super();
  }

  /**
   * 테넌트와 도메인 조합으로 정책을 조회합니다.
   */
  async findByTenantAndDomain(tenantId: string, domain: string): Promise<DomainPolicy | null> {
    const client = this.txManager.getClient() ?? this.db;

    const result = (await client
      .select()
      .from(domainPolicies)
      .where(and(eq(domainPolicies.tenantId, tenantId), eq(domainPolicies.domain, domain)))
      .limit(1)) as DomainPolicyRow[];

    if (result.length === 0) {
      return null;
    }

    return this.mapToDomainPolicy(result[0]);
  }

  /**
   * 테넌트의 모든 도메인 정책을 조회합니다.
   */
  async findAllByTenant(tenantId: string): Promise<DomainPolicy[]> {
    const client = this.txManager.getClient() ?? this.db;

    const result = (await client
      .select()
      .from(domainPolicies)
      .where(eq(domainPolicies.tenantId, tenantId))) as DomainPolicyRow[];
    return result.map((row) => this.mapToDomainPolicy(row));
  }

  /**
   * 도메인 정책을 upsert 방식으로 저장합니다.
   */
  async save(policy: DomainPolicy): Promise<DomainPolicy> {
    const client = this.txManager.getClient() ?? this.db;

    const result = (await client
      .insert(domainPolicies)
      .values({
        id: policy.id,
        tenantId: policy.tenantId,
        domain: policy.domain,
        role: policy.role,
        enabled: policy.enabled,
        createdAt: policy.createdAt,
      })
      .onConflictDoUpdate({
        target: [domainPolicies.tenantId, domainPolicies.domain],
        set: {
          id: policy.id,
          role: policy.role,
          enabled: policy.enabled,
          createdAt: policy.createdAt,
        },
      })
      .returning()) as DomainPolicyRow[];

    return this.mapToDomainPolicy(result[0]);
  }

  /**
   * 테넌트와 도메인 조합의 정책을 삭제합니다.
   */
  async delete(tenantId: string, domain: string): Promise<void> {
    const client = this.txManager.getClient() ?? this.db;

    await client
      .delete(domainPolicies)
      .where(and(eq(domainPolicies.tenantId, tenantId), eq(domainPolicies.domain, domain)));
  }

  async createAutoJoinIntent(
    input: DomainAutoJoinIntentInput,
  ): Promise<DomainAutoJoinIntentCreation> {
    const client = this.txManager.getClient() ?? this.db;
    const inserted = (await client
      .insert(domainAutoJoinIntents)
      .values(this.mapAutoJoinIntentToValues(input))
      .onConflictDoNothing({
        target: [domainAutoJoinIntents.tenantId, domainAutoJoinIntents.idempotencyKey],
      })
      .returning()) as DomainAutoJoinIntentRow[];

    const [created] = inserted;
    if (created) {
      return { intent: this.mapToAutoJoinIntent(created), created: true };
    }

    const existing = await this.findAutoJoinIntentWithClient(
      client,
      input.tenantId,
      input.idempotencyKey,
    );
    if (!existing) {
      throw new DomainAutoJoinRecoveryProblem("membership");
    }
    return { intent: existing, created: false };
  }

  async renewAutoJoinIntent(
    input: DomainAutoJoinIntentInput,
    expectedEventId: string,
  ): Promise<DomainAutoJoinIntentCreation> {
    const client = this.txManager.getClient() ?? this.db;
    const updated = (await client
      .update(domainAutoJoinIntents)
      .set(this.mapAutoJoinIntentToValues(input))
      .where(
        and(
          eq(domainAutoJoinIntents.tenantId, input.tenantId),
          eq(domainAutoJoinIntents.idempotencyKey, input.idempotencyKey),
          eq(domainAutoJoinIntents.eventId, expectedEventId),
          eq(domainAutoJoinIntents.eventStatus, "completed"),
          isNotNull(domainAutoJoinIntents.membershipId),
        ),
      )
      .returning()) as DomainAutoJoinIntentRow[];
    const [renewed] = updated;
    if (renewed) {
      return { intent: this.mapToAutoJoinIntent(renewed), created: true };
    }

    const existing = await this.findAutoJoinIntentWithClient(
      client,
      input.tenantId,
      input.idempotencyKey,
    );
    if (!existing) {
      throw new DomainAutoJoinRecoveryProblem("membership");
    }
    return { intent: existing, created: false };
  }

  async findAutoJoinIntent(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<DomainAutoJoinIntent | null> {
    const client = this.txManager.getClient() ?? this.db;
    return this.findAutoJoinIntentWithClient(client, tenantId, idempotencyKey);
  }

  async completeAutoJoinMembership(
    tenantId: string,
    idempotencyKey: string,
    membership: NonNullable<DomainAutoJoinIntent["membership"]>,
    expectedEventId: string,
  ): Promise<DomainAutoJoinIntent | null> {
    const client = this.txManager.getClient() ?? this.db;
    const updated = (await client
      .update(domainAutoJoinIntents)
      .set({
        membershipId: membership.id,
        membershipRole: membership.role,
        membershipCreatedAt: membership.createdAt,
        membershipUpdatedAt: membership.updatedAt,
      })
      .where(
        and(
          eq(domainAutoJoinIntents.tenantId, tenantId),
          eq(domainAutoJoinIntents.idempotencyKey, idempotencyKey),
          eq(domainAutoJoinIntents.eventId, expectedEventId),
          isNull(domainAutoJoinIntents.membershipId),
        ),
      )
      .returning()) as DomainAutoJoinIntentRow[];

    const [intent] = updated;
    if (intent) {
      return this.mapToAutoJoinIntent(intent);
    }
    return this.findAutoJoinIntentWithClient(client, tenantId, idempotencyKey);
  }

  async claimAutoJoinEvent(
    tenantId: string,
    idempotencyKey: string,
    claimId: string,
    claimExpiresAt: Date,
    expectedEventId: string,
  ): Promise<DomainAutoJoinIntent | null> {
    const client = this.txManager.getClient() ?? this.db;
    const updated = (await client
      .update(domainAutoJoinIntents)
      .set({
        eventStatus: "processing",
        eventClaimId: claimId,
        eventClaimExpiresAt: claimExpiresAt,
      })
      .where(
        and(
          eq(domainAutoJoinIntents.tenantId, tenantId),
          eq(domainAutoJoinIntents.idempotencyKey, idempotencyKey),
          eq(domainAutoJoinIntents.eventId, expectedEventId),
          isNotNull(domainAutoJoinIntents.membershipId),
          or(
            eq(domainAutoJoinIntents.eventStatus, "pending"),
            and(
              eq(domainAutoJoinIntents.eventStatus, "processing"),
              or(
                isNull(domainAutoJoinIntents.eventClaimExpiresAt),
                lte(domainAutoJoinIntents.eventClaimExpiresAt, new Date()),
              ),
            ),
          ),
        ),
      )
      .returning()) as DomainAutoJoinIntentRow[];
    const [intent] = updated;
    return intent ? this.mapToAutoJoinIntent(intent) : null;
  }

  async completeAutoJoinEvent(
    tenantId: string,
    idempotencyKey: string,
    claimId: string,
  ): Promise<DomainAutoJoinIntent | null> {
    const client = this.txManager.getClient() ?? this.db;
    const updated = (await client
      .update(domainAutoJoinIntents)
      .set({
        eventStatus: "completed",
        eventClaimId: null,
        eventClaimExpiresAt: null,
      })
      .where(
        and(
          eq(domainAutoJoinIntents.tenantId, tenantId),
          eq(domainAutoJoinIntents.idempotencyKey, idempotencyKey),
          eq(domainAutoJoinIntents.eventStatus, "processing"),
          eq(domainAutoJoinIntents.eventClaimId, claimId),
        ),
      )
      .returning()) as DomainAutoJoinIntentRow[];
    const [intent] = updated;
    return intent ? this.mapToAutoJoinIntent(intent) : null;
  }

  async releaseAutoJoinEvent(
    tenantId: string,
    idempotencyKey: string,
    claimId: string,
  ): Promise<void> {
    const client = this.txManager.getClient() ?? this.db;
    await client
      .update(domainAutoJoinIntents)
      .set({
        eventStatus: "pending",
        eventClaimId: null,
        eventClaimExpiresAt: null,
      })
      .where(
        and(
          eq(domainAutoJoinIntents.tenantId, tenantId),
          eq(domainAutoJoinIntents.idempotencyKey, idempotencyKey),
          eq(domainAutoJoinIntents.eventStatus, "processing"),
          eq(domainAutoJoinIntents.eventClaimId, claimId),
        ),
      );
  }

  async deleteUncommittedAutoJoinIntent(
    tenantId: string,
    idempotencyKey: string,
    expectedEventId: string,
  ): Promise<void> {
    const client = this.txManager.getClient() ?? this.db;
    await client
      .delete(domainAutoJoinIntents)
      .where(
        and(
          eq(domainAutoJoinIntents.tenantId, tenantId),
          eq(domainAutoJoinIntents.idempotencyKey, idempotencyKey),
          eq(domainAutoJoinIntents.eventId, expectedEventId),
          isNull(domainAutoJoinIntents.membershipId),
        ),
      );
  }

  private mapToDomainPolicy(row: DomainPolicyRow): DomainPolicy {
    return {
      id: row.id,
      tenantId: row.tenantId,
      domain: row.domain,
      role: row.role,
      enabled: row.enabled,
      createdAt: row.createdAt,
    };
  }

  private async findAutoJoinIntentWithClient(
    client: DrizzleDomainPolicyClient,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<DomainAutoJoinIntent | null> {
    const rows = (await client
      .select()
      .from(domainAutoJoinIntents)
      .where(
        and(
          eq(domainAutoJoinIntents.tenantId, tenantId),
          eq(domainAutoJoinIntents.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1)) as DomainAutoJoinIntentRow[];
    const [row] = rows;
    return row ? this.mapToAutoJoinIntent(row) : null;
  }

  private mapAutoJoinIntentToValues(intent: DomainAutoJoinIntentInput) {
    return {
      tenantId: intent.tenantId,
      idempotencyKey: intent.idempotencyKey,
      userId: intent.userId,
      email: intent.email,
      domain: intent.domain,
      role: intent.role,
      membershipId: intent.membership?.id ?? null,
      membershipRole: intent.membership?.role ?? null,
      membershipCreatedAt: intent.membership?.createdAt ?? null,
      membershipUpdatedAt: intent.membership?.updatedAt ?? null,
      eventStatus: intent.eventStatus,
      eventClaimId: intent.eventClaimId,
      eventClaimExpiresAt: intent.eventClaimExpiresAt,
      eventId: intent.eventId,
      eventOccurredAt: intent.eventOccurredAt,
      createdAt: intent.createdAt,
    };
  }

  private mapToAutoJoinIntent(row: DomainAutoJoinIntentRow): DomainAutoJoinIntent {
    const membership =
      row.membershipId && row.membershipRole && row.membershipCreatedAt && row.membershipUpdatedAt
        ? {
            id: row.membershipId,
            tenantId: row.tenantId,
            userId: row.userId,
            role: row.membershipRole,
            createdAt: row.membershipCreatedAt,
            updatedAt: row.membershipUpdatedAt,
          }
        : null;
    return {
      tenantId: row.tenantId,
      idempotencyKey: row.idempotencyKey,
      userId: row.userId,
      email: row.email,
      domain: row.domain,
      role: row.role,
      membership,
      eventStatus: row.eventStatus,
      eventClaimId: row.eventClaimId,
      eventClaimExpiresAt: row.eventClaimExpiresAt,
      eventId: row.eventId,
      eventOccurredAt: row.eventOccurredAt,
      createdAt: row.createdAt,
    };
  }
}
