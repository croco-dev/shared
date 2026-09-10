import "reflect-metadata";
import type { Invitation } from "@croco/invitation-core";
import type { TxManager } from "@croco/tx-core";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DrizzleInvitationClient,
  DrizzleInvitationStore,
} from "../libs/DrizzleInvitationStore";
import {
  type InvitationTokenCipher,
  InvitationTokenCipherProblem,
} from "../libs/InvitationTokenCipher";

const createInvitation = (overrides: Partial<Invitation> = {}): Invitation => {
  return {
    id: overrides.id ?? "inv-1",
    tenantId: overrides.tenantId ?? "tenant-1",
    inviterId: overrides.inviterId ?? "user-1",
    email: overrides.email ?? "member@croco.dev",
    tokenHash: overrides.tokenHash ?? "hash-1",
    type: overrides.type ?? "email",
    role: overrides.role ?? "member",
    status: overrides.status ?? "pending",
    expiresAt: overrides.expiresAt ?? new Date("2026-01-10T00:00:00.000Z"),
    acceptedAt: overrides.acceptedAt ?? null,
    revokedAt: overrides.revokedAt ?? null,
    createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
  };
};

const createUpdateChain = (rows: Invitation[]) => {
  const where = vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue(rows),
  });

  return {
    set: vi.fn().mockReturnValue({
      where,
    }),
    where,
  };
};

const createSelectForUpdateChain = (rows: Array<{ id: string }>) => {
  const forUpdate = vi.fn().mockResolvedValue(rows);
  return {
    query: {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          for: forUpdate,
        }),
      }),
    },
    forUpdate,
  };
};

describe("DrizzleInvitationStore", () => {
  let store!: DrizzleInvitationStore;
  let mockDb!: {
    select: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockDb = {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
    };

    const mockTxManager = {
      getClient: vi.fn().mockReturnValue(mockDb),
      run: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    };

    store = new DrizzleInvitationStore(
      mockDb as unknown as DrizzleInvitationClient,
      mockTxManager as unknown as TxManager<DrizzleInvitationClient>,
    );
  });

  it.each([0, 6, "6"])("should return issued count %s across all statuses", async (total) => {
    const since = new Date("2026-01-01T00:00:00.000Z");
    const where = vi.fn().mockResolvedValue([{ total }]);
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({ where }),
    });

    expect(await store.countIssuedByTenant("tenant-1", since)).toBe(Number(total));

    const query = new PgDialect().sqlToQuery(where.mock.calls[0][0] as SQL);
    expect(query.sql).toBe('("invitations"."tenant_id" = $1 and "invitations"."created_at" >= $2)');
    expect(query.params).toEqual(["tenant-1", since.toISOString()]);
    const selection = mockDb.select.mock.calls[0][0] as { total: SQL };
    expect(new PgDialect().sqlToQuery(selection.total).sql).toBe("count(*)");
  });

  it("should retain the pending-only count predicate", async () => {
    const since = new Date("2026-01-01T00:00:00.000Z");
    const where = vi.fn().mockResolvedValue([{ total: 2 }]);
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({ where }),
    });

    expect(await store.countPendingByTenant("tenant-1", since)).toBe(2);

    const query = new PgDialect().sqlToQuery(where.mock.calls[0][0] as SQL);
    expect(query.sql).toBe(
      '("invitations"."tenant_id" = $1 and "invitations"."status" = $2 and "invitations"."created_at" >= $3)',
    );
    expect(query.params).toEqual(["tenant-1", "pending", since.toISOString()]);
  });

  it("should save and find invitation by id", async () => {
    const invitation = createInvitation();

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([invitation]),
        }),
      }),
    });

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([invitation]),
        }),
      }),
    });

    await store.save(invitation);
    const found = await store.findById("inv-1");

    expect(found).not.toBeNull();
    expect(found?.id).toBe("inv-1");
  });

  it("should find invitation by token hash", async () => {
    const invitation = createInvitation({ tokenHash: "token-hash-1" });

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([invitation]),
        }),
      }),
    });

    const found = await store.findByTokenHash("token-hash-1");

    expect(found?.tokenHash).toBe("token-hash-1");
  });

  it("should find invitation by tenant and email", async () => {
    const invitation = createInvitation({
      tenantId: "tenant-1",
      email: "member@croco.dev",
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    });
    const orderBy = vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue([invitation]),
    });

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([invitation]),
          orderBy,
        }),
      }),
    });

    const found = await store.findByTenantAndEmail("tenant-1", "member@croco.dev");

    expect(found?.id).toBe("inv-1");
    expect(orderBy).toHaveBeenCalledTimes(1);
    const orderExpressions = orderBy.mock.calls[0];
    expect(orderExpressions).toBeDefined();
    const orderQueries = orderExpressions?.map((expression) =>
      new PgDialect().sqlToQuery(expression as SQL),
    );
    expect(orderQueries?.map((query) => query.sql)).toEqual([
      'case when "invitations"."status" = \'pending\' and "invitations"."expires_at" > statement_timestamp() at time zone \'UTC\' then 1 else 0 end desc',
      '"invitations"."created_at" desc',
      '"invitations"."id" desc',
    ]);
  });

  it("should return all invitations by tenant", async () => {
    const rows = [
      createInvitation({ id: "inv-1", tenantId: "tenant-1" }),
      createInvitation({
        id: "inv-2",
        tenantId: "tenant-1",
        tokenHash: "hash-2",
      }),
    ];

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
      }),
    });

    const found = await store.findAllByTenant("tenant-1");

    expect(found).toHaveLength(2);
    expect(found.map((invitation) => invitation.id).sort()).toEqual(["inv-1", "inv-2"]);
  });

  it("should atomically persist an email invitation and its delivery intent", async () => {
    const invitation = createInvitation();
    const creationRow = {
      invitationId: invitation.id,
      tenantId: invitation.tenantId,
      idempotencyKey: "request-1",
      requestFingerprint: "fingerprint-1",
      tokenCiphertext: "encrypted-token",
      notificationIdempotencyKey: "notification-1",
      notificationStatus: "pending" as const,
      notificationClaimId: null,
      notificationClaimExpiresAt: null,
      eventStatus: "pending" as const,
      eventClaimId: null,
      eventClaimExpiresAt: null,
      eventId: "event-1",
      eventOccurredAt: new Date("2026-01-01T00:00:00.000Z"),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    });
    const insert = vi
      .fn()
      .mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([creationRow]),
          }),
        }),
      })
      .mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([invitation]),
          }),
        }),
      });
    const client = { select, insert };
    const run = vi.fn(async (fn: () => Promise<unknown>) => fn());
    const creationStore = new DrizzleInvitationStore(
      client as unknown as DrizzleInvitationClient,
      {
        getClient: vi.fn().mockReturnValue(client),
        run,
      } as unknown as TxManager<DrizzleInvitationClient>,
      {
        encrypt: vi.fn().mockReturnValue("encrypted-token"),
        decrypt: vi.fn().mockReturnValue("plaintext-token"),
      } satisfies InvitationTokenCipher,
    );

    const creation = await creationStore.createEmailInvitation({
      invitation,
      ...creationRow,
      token: "plaintext-token",
    });

    expect(creation.token).toBe("plaintext-token");
    expect(creation.notificationStatus).toBe("pending");
    expect(run).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(2);
  });

  it("should model a missing token cipher as a stable Problem", async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    });
    mockDb.insert.mockReturnValue({
      values: vi.fn(),
    });
    const storeWithoutCipher = new DrizzleInvitationStore(
      mockDb as unknown as DrizzleInvitationClient,
      {
        getClient: vi.fn().mockReturnValue(mockDb),
        run: vi.fn(async (fn: () => Promise<unknown>) => fn()),
      } as unknown as TxManager<DrizzleInvitationClient>,
    );

    await expect(
      storeWithoutCipher.createEmailInvitation({
        invitation: createInvitation({ status: "creating" }),
        idempotencyKey: "request-1",
        requestFingerprint: "fingerprint-1",
        token: "plaintext-token",
        notificationIdempotencyKey: "notification-1",
        notificationStatus: "pending",
        notificationClaimId: null,
        notificationClaimExpiresAt: null,
        eventStatus: "pending",
        eventClaimId: null,
        eventClaimExpiresAt: null,
        eventId: "event-1",
        eventOccurredAt: new Date("2026-01-01T00:00:00.000Z"),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow(InvitationTokenCipherProblem);
  });

  it("should update status when invitation exists", async () => {
    const accepted = createInvitation({ status: "accepted" });
    mockDb.update.mockReturnValue(createUpdateChain([accepted]));

    const updated = await store.updateStatus("tenant-1", "inv-1", "accepted");

    expect(updated?.status).toBe("accepted");
    expect(mockDb.update.mock.results[0].value.where).toHaveBeenCalledTimes(1);
  });

  it("should reject completion from a stale creation-phase claim", async () => {
    mockDb.update.mockReturnValue(createUpdateChain([]));

    await expect(
      store.completeEmailInvitationEvent("tenant-1", "request-1", "stale-claim"),
    ).resolves.toBeNull();
  });

  it("should return null when updating missing invitation", async () => {
    mockDb.update.mockReturnValue(createUpdateChain([]));

    const updated = await store.updateStatus("tenant-1", "missing", "revoked");

    expect(updated).toBeNull();
  });

  it("should accept invitation atomically and single-use", async () => {
    const accepted = createInvitation({ id: "inv-1", status: "accepted" });

    mockDb.update
      .mockReturnValueOnce(createUpdateChain([accepted]))
      .mockReturnValueOnce(createUpdateChain([]));

    const first = await store.updateStatus("tenant-1", "inv-1", "accepted");
    const second = await store.updateStatus("tenant-1", "inv-1", "accepted");

    expect(first?.status).toBe("accepted");
    expect(second).toBeNull();
  });

  it("should scope compare-and-set status updates by tenant", async () => {
    const accepted = createInvitation({
      id: "inv-1",
      tenantId: "tenant-1",
      status: "accepted",
    });
    const lock = createSelectForUpdateChain([{ id: accepted.id }]);
    mockDb.select.mockReturnValue(lock.query);
    mockDb.update.mockReturnValue(createUpdateChain([accepted]));

    const updated = await store.compareAndSetStatus("tenant-1", "inv-1", "pending", "accepted");

    expect(updated?.tenantId).toBe("tenant-1");
    expect(lock.forUpdate).toHaveBeenCalledWith("update");
    expect(mockDb.update.mock.results[0].value.where).toHaveBeenCalledTimes(1);
  });

  it("should compare expiry with UTC acceptance times independently of the session time zone", async () => {
    const acceptedAt = new Date("2026-01-01T00:00:00.000Z");
    const lock = createSelectForUpdateChain([{ id: "inv-1" }]);
    mockDb.select.mockReturnValue(lock.query);
    mockDb.update.mockReturnValue(createUpdateChain([]));

    await store.compareAndSetStatus("tenant-1", "inv-1", "pending", "accepted", {
      acceptedAt,
    });

    const whereCall = mockDb.update.mock.results[0].value.where.mock.calls[0];
    expect(whereCall).toBeDefined();
    const query = new PgDialect().sqlToQuery(whereCall?.[0] as SQL);
    const setCall = mockDb.update.mock.results[0].value.set.mock.calls[0]?.[0] as
      | { acceptedAt?: SQL }
      | undefined;
    const acceptedAtQuery = new PgDialect().sqlToQuery(setCall?.acceptedAt as SQL);

    expect(query.sql).toContain('"invitations"."tenant_id" = $1');
    expect(query.sql).toContain('"invitations"."id" = $2');
    expect(query.sql).toContain('"invitations"."status" = $3');
    expect(query.sql).toContain(
      "\"invitations\".\"expires_at\" > greatest($4::timestamptz AT TIME ZONE 'UTC', statement_timestamp() AT TIME ZONE 'UTC')",
    );
    expect(query.params).toEqual(["tenant-1", "inv-1", "pending", acceptedAt.toISOString()]);
    expect(acceptedAtQuery.sql).toBe(
      "greatest($1::timestamptz AT TIME ZONE 'UTC', statement_timestamp() AT TIME ZONE 'UTC')",
    );
    expect(acceptedAtQuery.params).toEqual([acceptedAt.toISOString()]);
    expect(lock.forUpdate).toHaveBeenCalledWith("update");
    expect(lock.forUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mockDb.update.mock.invocationCallOrder[0],
    );
  });

  it("should use one UTC database clock after locking when acceptedAt is omitted", async () => {
    const lock = createSelectForUpdateChain([{ id: "inv-1" }]);
    mockDb.select.mockReturnValue(lock.query);
    mockDb.update.mockReturnValue(createUpdateChain([]));

    await store.compareAndSetStatus("tenant-1", "inv-1", "pending", "accepted");

    const update = mockDb.update.mock.results[0].value;
    const whereCall = update.where.mock.calls[0];
    const query = new PgDialect().sqlToQuery(whereCall?.[0] as SQL);
    const setCall = update.set.mock.calls[0]?.[0] as { acceptedAt?: SQL } | undefined;
    const acceptedAtQuery = new PgDialect().sqlToQuery(setCall?.acceptedAt as SQL);
    expect(query.sql).toContain(
      '"invitations"."expires_at" > statement_timestamp() AT TIME ZONE \'UTC\'',
    );
    expect(query.params).toEqual(["tenant-1", "inv-1", "pending"]);
    expect(acceptedAtQuery.sql).toBe("statement_timestamp() AT TIME ZONE 'UTC'");
    expect(lock.forUpdate).toHaveBeenCalledWith("update");
    expect(lock.forUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mockDb.update.mock.invocationCallOrder[0],
    );
  });
});
