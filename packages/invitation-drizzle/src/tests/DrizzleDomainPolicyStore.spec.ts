import "reflect-metadata";
import { DomainAutoJoinRecoveryProblem } from "@croco/invitation-core";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { DomainAutoJoinIntentInput, DomainPolicy } from "@croco/invitation-core";
import type { TxManager } from "@croco/tx-core";
import type { DrizzleDb } from "@croco/tx-drizzle";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DrizzleDomainPolicyClient,
  DrizzleDomainPolicyStore,
} from "../libs/DrizzleDomainPolicyStore";

const createPolicy = (overrides: Partial<DomainPolicy> = {}): DomainPolicy => {
  return {
    id: overrides.id ?? "dp-1",
    tenantId: overrides.tenantId ?? "tenant-1",
    domain: overrides.domain ?? "croco.dev",
    role: overrides.role ?? "member",
    enabled: overrides.enabled ?? true,
    createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
  };
};

const createAutoJoinIntent = (
  overrides: Partial<DomainAutoJoinIntentInput> = {},
): DomainAutoJoinIntentInput => ({
  idempotencyKey: overrides.idempotencyKey ?? "auto-join-key",
  tenantId: overrides.tenantId ?? "tenant-1",
  userId: overrides.userId ?? "user-1",
  email: overrides.email ?? "user@croco.dev",
  domain: overrides.domain ?? "croco.dev",
  role: overrides.role ?? "member",
  membership: overrides.membership ?? null,
  eventStatus: overrides.eventStatus ?? "pending",
  eventClaimId: overrides.eventClaimId ?? null,
  eventClaimExpiresAt: overrides.eventClaimExpiresAt ?? null,
  eventId: overrides.eventId ?? "event-1",
  eventOccurredAt: overrides.eventOccurredAt ?? new Date("2026-01-01T00:00:00.000Z"),
  createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
});

const toAutoJoinRow = (intent: DomainAutoJoinIntentInput) => ({
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
});

describe("DrizzleDomainPolicyStore", () => {
  let store!: DrizzleDomainPolicyStore;

  let mockDb!: {
    select: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockDb = {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };

    const mockTxManager = {
      getClient: vi.fn().mockReturnValue(null),
    };

    store = new DrizzleDomainPolicyStore(
      mockDb as unknown as DrizzleDomainPolicyClient,
      mockTxManager as unknown as TxManager<DrizzleDomainPolicyClient>,
    );
  });

  it("should save and find policy by tenant and domain", async () => {
    const policy = createPolicy();

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([policy]),
        }),
      }),
    });

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([policy]),
        }),
      }),
    });

    await store.save(policy);
    const found = await store.findByTenantAndDomain("tenant-1", "croco.dev");

    expect(found).not.toBeNull();
    expect(found?.id).toBe("dp-1");
  });

  it("should return all policies by tenant", async () => {
    const rows = [
      createPolicy({ id: "dp-1", tenantId: "tenant-1", domain: "croco.dev" }),
      createPolicy({ id: "dp-2", tenantId: "tenant-1", domain: "example.com" }),
    ];

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
      }),
    });

    const found = await store.findAllByTenant("tenant-1");

    expect(found).toHaveLength(2);
    expect(found.map((policy) => policy.id).sort()).toEqual(["dp-1", "dp-2"]);
  });

  it("should update existing policy when saving same tenant and domain", async () => {
    const initial = createPolicy({ id: "dp-1", role: "member" });
    const updated = createPolicy({ id: "dp-2", role: "viewer" });

    mockDb.insert
      .mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([initial]),
          }),
        }),
      })
      .mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated]),
          }),
        }),
      });

    const first = await store.save(initial);
    const second = await store.save(updated);

    expect(first.role).toBe("member");
    expect(second.id).toBe("dp-2");
    expect(second.role).toBe("viewer");
  });

  it("should delete policy by tenant and domain", async () => {
    mockDb.delete.mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });

    await expect(store.delete("tenant-1", "croco.dev")).resolves.toBeUndefined();
    expect(mockDb.delete).toHaveBeenCalled();
  });

  it("should create and return a durable auto-join intent", async () => {
    const intent = createAutoJoinIntent();
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([toAutoJoinRow(intent)]),
        }),
      }),
    });

    await expect(store.createAutoJoinIntent(intent)).resolves.toEqual({
      intent,
      created: true,
    });
  });

  it("should renew with an atomic tenant, key, completed-event and committed-membership fence", async () => {
    const intent = createAutoJoinIntent({ eventId: "event-2", role: "viewer" });
    const where = vi
      .fn()
      .mockReturnValue({ returning: vi.fn().mockResolvedValue([toAutoJoinRow(intent)]) });
    const set = vi.fn().mockReturnValue({ where });
    mockDb.update.mockReturnValue({ set });

    await expect(store.renewAutoJoinIntent(intent, "event-1")).resolves.toEqual({
      intent,
      created: true,
    });

    expect(set).toHaveBeenCalledWith(toAutoJoinRow(intent));
    const query = new PgDialect().sqlToQuery(where.mock.calls[0][0] as SQL);
    expect(query.sql).toBe(
      '("domain_auto_join_intents"."tenant_id" = $1 and "domain_auto_join_intents"."idempotency_key" = $2 and "domain_auto_join_intents"."event_id" = $3 and "domain_auto_join_intents"."event_status" = $4 and "domain_auto_join_intents"."membership_id" is not null)',
    );
    expect(query.params).toEqual([intent.tenantId, intent.idempotencyKey, "event-1", "completed"]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("should return the current generation when a renewal loses its compare-and-swap", async () => {
    const winner = createAutoJoinIntent({ eventId: "event-winner" });
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
      }),
    });
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockReturnValue({ limit: vi.fn().mockResolvedValue([toAutoJoinRow(winner)]) }),
      }),
    });
    await expect(
      store.renewAutoJoinIntent(createAutoJoinIntent({ eventId: "event-loser" }), "event-1"),
    ).resolves.toEqual({ intent: winner, created: false });
  });

  it("should reject renewal when no existing intent remains", async () => {
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
      }),
    });
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
      }),
    });
    await expect(
      store.renewAutoJoinIntent(createAutoJoinIntent(), "event-1"),
    ).rejects.toBeInstanceOf(DomainAutoJoinRecoveryProblem);
  });

  it("should include generation fences in membership completion, event claims and cleanup SQL", async () => {
    const where = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) });
    mockDb.update.mockReturnValue({ set: vi.fn().mockReturnValue({ where }) });
    mockDb.delete.mockReturnValue({ where });
    const current = createAutoJoinIntent({ eventId: "event-current" });
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockReturnValue({ limit: vi.fn().mockResolvedValue([toAutoJoinRow(current)]) }),
      }),
    });
    const membership = {
      id: "membership-old",
      tenantId: "tenant-1",
      userId: "user-1",
      role: "member" as const,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    await expect(
      store.completeAutoJoinMembership("tenant-1", "auto-join-key", membership, "event-old"),
    ).resolves.toEqual(current);
    await expect(
      store.claimAutoJoinEvent("tenant-1", "auto-join-key", "claim-old", new Date(), "event-old"),
    ).resolves.toBeNull();
    await store.deleteUncommittedAutoJoinIntent("tenant-1", "auto-join-key", "event-old");
    expect(where).toHaveBeenCalledTimes(3);
    for (const [condition] of where.mock.calls) {
      const query = new PgDialect().sqlToQuery(condition as SQL);
      expect(query.sql).toContain('"domain_auto_join_intents"."event_id" = $3');
      expect(query.params.slice(0, 3)).toEqual(["tenant-1", "auto-join-key", "event-old"]);
    }
  });

  it("should persist membership and fence event publication with a claim", async () => {
    const membership = {
      id: "membership-1",
      tenantId: "tenant-1",
      userId: "user-1",
      role: "member" as const,
      createdAt: new Date("2026-01-01T00:01:00.000Z"),
      updatedAt: new Date("2026-01-01T00:01:00.000Z"),
    };
    const committed = createAutoJoinIntent({ membership });
    const claimed = createAutoJoinIntent({
      membership,
      eventStatus: "processing",
      eventClaimId: "claim-1",
      eventClaimExpiresAt: new Date("2026-01-01T00:06:00.000Z"),
    });
    mockDb.update
      .mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([toAutoJoinRow(committed)]),
          }),
        }),
      })
      .mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([toAutoJoinRow(claimed)]),
          }),
        }),
      });

    await expect(
      store.completeAutoJoinMembership("tenant-1", "auto-join-key", membership, committed.eventId),
    ).resolves.toMatchObject({ membership });
    await expect(
      store.claimAutoJoinEvent(
        "tenant-1",
        "auto-join-key",
        "claim-1",
        claimed.eventClaimExpiresAt ?? new Date(),
        claimed.eventId,
      ),
    ).resolves.toMatchObject({ eventStatus: "processing", eventClaimId: "claim-1" });
  });
});
