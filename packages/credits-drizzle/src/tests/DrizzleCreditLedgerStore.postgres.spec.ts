import {
  createCreditLedgerStoreConformanceSuite,
  CreditAccountMismatchProblem,
  creditAmount,
  createCreditIdempotencyIdentity,
  CreditDuplicateConflictProblem,
  CreditLedgerService,
  CreditReservationMismatchProblem,
  CreditRefundMismatchProblem,
  InsufficientCreditsProblem,
} from "@croco/credits-core";
import { TxManager } from "@croco/tx-core";
import { createDrizzleTxAdapter } from "@croco/tx-drizzle";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCreditsSchema,
  creditAccounts,
  creditAllocations,
  creditGrantLots,
  creditIdempotencyRecords,
  creditLedgerEventIntents,
  creditReservationAllocations,
  creditReservations,
  creditTransactions,
  type DrizzleCreditTxManager,
  DrizzleCreditLedgerStore,
  dropCreditsSchema,
} from "../index";

const connectionString = process.env.CREDITS_POSTGRES_URL ?? "";
const describePostgres = connectionString ? describe : describe.skip;
type DrizzleCreditTransaction = NonNullable<ReturnType<DrizzleCreditTxManager["getClient"]>>;

const schema = {
  creditAccounts,
  creditAllocations,
  creditGrantLots,
  creditIdempotencyRecords,
  creditLedgerEventIntents,
  creditReservationAllocations,
  creditReservations,
  creditTransactions,
};

describePostgres("DrizzleCreditLedgerStore PostgreSQL conformance", () => {
  const pool = new Pool({ connectionString, max: 12 });
  const db = drizzle(pool, { schema });
  const txManager = new TxManager(
    createDrizzleTxAdapter(db as unknown as Parameters<typeof createDrizzleTxAdapter>[0]),
  ) as unknown as TxManager<DrizzleCreditTransaction>;

  beforeAll(async () => {
    await dropCreditsSchema(db);
    await createCreditsSchema(db);
  });

  afterAll(async () => {
    await dropCreditsSchema(db);
    await pool.end();
  });

  async function reset(): Promise<void> {
    await db.execute(sql`
      truncate table
        credit_ledger_event_intents,
        credit_idempotency_records,
        credit_reservation_allocations,
        credit_allocations,
        credit_reservations,
        credit_grant_lots,
        credit_transactions,
        credit_accounts
      restart identity cascade
    `);
  }

  async function seedClaimIntents(count: number) {
    await reset();
    const store = new DrizzleCreditLedgerStore(db, txManager);
    let sequence = 0;
    const service = new CreditLedgerService({ store, idGenerator: () => `claim-${++sequence}` });
    const { account } = await service.openAccount({
      tenantId: "claim-tenant",
      idempotencyKey: "claim-open",
      reference: { type: "test", id: "claim" },
    });
    for (let index = 0; index < count; index += 1) {
      await service.grantCredits({
        accountId: account.id,
        amount: creditAmount("1"),
        idempotencyKey: `claim-grant-${index}`,
        reference: { type: "test", id: "claim" },
      });
    }
    return store;
  }

  it("atomically leases disjoint batches to concurrent independent stores", async () => {
    const first = await seedClaimIntents(6);
    const second = new DrizzleCreditLedgerStore(db, txManager);
    const [left, right] = await Promise.all([
      first.claimPendingEventIntents(3),
      second.claimPendingEventIntents(3),
    ]);
    expect(left).toHaveLength(3);
    expect(right).toHaveLength(3);
    expect(new Set([...left, ...right].map((intent) => intent.eventId)).size).toBe(6);
    expect(await first.claimPendingEventIntents()).toEqual([]);
    expect(await first.listPendingEventIntents()).toHaveLength(6);
  });

  it("expires leases using elapsed PostgreSQL time", async () => {
    const store = await seedClaimIntents(1);
    const [first] = await store.claimPendingEventIntents(1, 20);
    await db.execute(sql`select pg_sleep(0.04)`);
    const [second] = await store.claimPendingEventIntents(1);
    expect(second?.eventId).toBe(first?.eventId);
    expect(second?.claimToken).not.toBe(first?.claimToken);
  });

  it("reclaims expired leases and fences stale acknowledgement and release", async () => {
    const store = await seedClaimIntents(1);
    const [original] = await store.claimPendingEventIntents();
    if (!original) throw new Error("missing claim fixture");
    await db
      .update(creditLedgerEventIntents)
      .set({ claimExpiresAt: sql`clock_timestamp() - interval '1 millisecond'` })
      .where(eq(creditLedgerEventIntents.eventId, original.eventId));
    expect(await store.markEventIntentPublished(original.eventId, original.claimToken)).toBe(false);
    expect(await store.releaseEventIntentClaim(original.eventId, original.claimToken)).toBe(false);
    const [replacement] = await store.claimPendingEventIntents(1, 60_000, original.eventId);
    if (!replacement) throw new Error("missing reclaimed fixture");
    expect(replacement.claimToken).not.toBe(original.claimToken);
    expect(replacement.eventId).toBe(original.eventId);
    expect(await store.markEventIntentPublished(original.eventId, original.claimToken)).toBe(false);
    expect(await store.releaseEventIntentClaim(original.eventId, original.claimToken)).toBe(false);
    expect(await store.releaseEventIntentClaim(replacement.eventId, replacement.claimToken)).toBe(
      true,
    );
    const [finalClaim] = await store.claimPendingEventIntents();
    if (!finalClaim) throw new Error("missing final claim fixture");
    expect(await store.markEventIntentPublished(finalClaim.eventId, finalClaim.claimToken)).toBe(
      true,
    );
    expect(await store.markEventIntentPublished(finalClaim.eventId, finalClaim.claimToken)).toBe(
      false,
    );
    expect(await store.claimPendingEventIntents()).toEqual([]);
  });

  it("skips locked pending rows without waiting for their transaction", async () => {
    const store = await seedClaimIntents(2);
    const [locked] = await store.listPendingEventIntents();
    if (!locked) throw new Error("missing locked fixture");
    await db.transaction(async (tx) => {
      await tx
        .select()
        .from(creditLedgerEventIntents)
        .where(eq(creditLedgerEventIntents.eventId, locked.eventId))
        .for("update");
      const claims = await store.claimPendingEventIntents();
      expect(claims).toHaveLength(1);
      expect(claims[0]?.eventId).not.toBe(locked.eventId);
    });
    const claims = await store.claimPendingEventIntents();
    expect(claims.map((intent) => intent.eventId)).toEqual([locked.eventId]);
  });

  it("rejects claiming from an ambient transaction before exposing its intents", async () => {
    const store = await seedClaimIntents(1);
    await txManager.run(async () => {
      await expect(store.claimPendingEventIntents()).rejects.toThrow(
        "outside an active transaction",
      );
    });
    expect(await store.claimPendingEventIntents()).toHaveLength(1);
  });

  it("adds lease columns to existing rows idempotently while preserving publication state", async () => {
    const store = await seedClaimIntents(2);
    const [published] = await store.claimPendingEventIntents(1);
    if (!published) throw new Error("missing migration fixture");
    await store.markEventIntentPublished(published.eventId, published.claimToken);
    await db.execute(
      sql`alter table credit_ledger_event_intents drop column claim_token, drop column claim_expires_at`,
    );
    await createCreditsSchema(db);
    await createCreditsSchema(db);
    const claims = await store.claimPendingEventIntents();
    expect(claims).toHaveLength(1);
    expect(claims[0]?.eventId).not.toBe(published.eventId);
    const rows = await db
      .select()
      .from(creditLedgerEventIntents)
      .where(eq(creditLedgerEventIntents.eventId, published.eventId));
    expect(rows[0]?.publishedAt).toBeInstanceOf(Date);
    expect(rows[0]?.claimToken).toBeNull();
  });

  const suite = createCreditLedgerStoreConformanceSuite({
    storeName: "drizzle-postgres",
    createStore: () => new DrizzleCreditLedgerStore(db, txManager),
  });

  for (const testCase of suite.cases) {
    // oxlint-disable-next-line jest/valid-title -- exported conformance cases own stable names
    it(testCase.name, async () => {
      await reset();
      await testCase.run();
    });
  }

  it.each([
    { source: "consume", refundAt: "2026-08-02T00:00:00.000Z" },
    { source: "consume", refundAt: "2026-08-01T00:00:00.000Z" },
    { source: "commit", refundAt: "2026-08-02T00:00:00.000Z" },
    { source: "commit", refundAt: "2026-08-01T00:00:00.000Z" },
  ] as const)(
    "persists spendable partial refunds from $source at $refundAt",
    async ({ source, refundAt }) => {
      await reset();
      let sequence = 0;
      let now = new Date("2026-07-30T00:00:00.000Z");
      const service = new CreditLedgerService({
        store: new DrizzleCreditLedgerStore(db, txManager),
        clock: () => now,
        idGenerator: () => `refund-expiry-${++sequence}`,
      });
      const metadata = (id: string) => ({ idempotencyKey: id, reference: { type: "test", id } });
      const { account } = await service.openAccount({
        tenantId: "refund-expiry",
        ...metadata("open"),
      });
      const grant = await service.grantCredits({
        accountId: account.id,
        amount: creditAmount("10"),
        expiresAt: new Date("2026-08-01T00:00:00.000Z"),
        meterKeys: ["api"],
        ...metadata("grant"),
      });
      const spendInput = { accountId: account.id, amount: creditAmount("10"), meterKey: "api" };
      const reserved =
        source === "commit"
          ? await service.reserveCredits({ ...spendInput, ...metadata("reserve") })
          : undefined;
      const spent = reserved
        ? await service.commitCredits({
            accountId: account.id,
            reservationId: reserved.reservation!.id,
            amount: creditAmount("10"),
            ...metadata("commit"),
          })
        : await service.consumeCredits({ ...spendInput, ...metadata("consume") });
      const original = spent.transactions[0]!;
      now = new Date(refundAt);

      for (const amount of ["4", "6"]) {
        const input = {
          accountId: account.id,
          consumptionTransactionId: original.id,
          amount: creditAmount(amount),
          ...metadata(`refund-${amount}`),
        };
        const refunded = await service.refundCredits(input);
        const transaction = refunded.transactions[0]!;
        expect(transaction).toMatchObject({
          relatedTransactionId: original.id,
          meterKey: "api",
          allocations: [{ grantTransactionId: grant.transactions[0]!.id, amount }],
          grant: { source: `refund:${original.id}`, meterKeys: ["api"] },
        });
        expect(transaction.grant?.expiresAt).toBeUndefined();
        const [lot] = await db
          .select()
          .from(creditGrantLots)
          .where(eq(creditGrantLots.grantTransactionId, transaction.id));
        expect(lot).toMatchObject({ expiresAt: null, available: amount, meterKeys: ["api"] });
        const [persisted] = await db
          .select()
          .from(creditTransactions)
          .where(eq(creditTransactions.id, transaction.id));
        expect(persisted).toMatchObject({
          grantExpiresAt: null,
          relatedTransactionId: original.id,
        });
        const balance = await service.getBalance(account.id);
        expect(await service.refundCredits(input)).toMatchObject({
          replayed: true,
          transactions: refunded.transactions,
        });
        expect(await service.getBalance(account.id)).toEqual(balance);
      }
      expect(await db.select().from(creditGrantLots)).toHaveLength(3);
      await expect(
        service.refundCredits({
          accountId: account.id,
          consumptionTransactionId: original.id,
          amount: creditAmount("1"),
          ...metadata("over-refund"),
        }),
      ).rejects.toBeInstanceOf(CreditRefundMismatchProblem);
      await expect(
        service.consumeCredits({
          ...spendInput,
          meterKey: "other",
          ...metadata("wrong-meter"),
        }),
      ).rejects.toBeInstanceOf(InsufficientCreditsProblem);
      expect(await service.getBalance(account.id)).toMatchObject({
        available: "10",
        consumed: "0",
      });
      const consumed = await service.consumeCredits({ ...spendInput, ...metadata("spend-refund") });
      expect(consumed.transactions[0]?.allocations.map((allocation) => allocation.amount)).toEqual([
        "4",
        "6",
      ]);
      expect(await service.getBalance(account.id)).toMatchObject({
        available: "0",
        consumed: "10",
      });
      const lots = await db.select().from(creditGrantLots);
      expect(lots.every((lot) => lot.available === "0")).toBe(true);
    },
  );

  it.each([
    { firstExpiry: "2026-08-03T00:00:00.000Z", expectedExpiry: "2026-08-03T00:00:00.000Z" },
    { firstExpiry: "2026-08-01T00:00:00.000Z", expectedExpiry: "2026-08-04T00:00:00.000Z" },
  ])(
    "retains the earliest live refund expiry when original expiry is $firstExpiry",
    async ({ firstExpiry, expectedExpiry }) => {
      await reset();
      let sequence = 0;
      let now = new Date("2026-07-30T00:00:00.000Z");
      const service = new CreditLedgerService({
        store: new DrizzleCreditLedgerStore(db, txManager),
        clock: () => now,
        idGenerator: () => `refund-mixed-${++sequence}`,
      });
      const metadata = (id: string) => ({ idempotencyKey: id, reference: { type: "test", id } });
      const { account } = await service.openAccount({
        tenantId: "refund-mixed",
        ...metadata("open"),
      });
      for (const [index, expiresAt] of [
        firstExpiry,
        "2026-08-04T00:00:00.000Z",
        undefined,
      ].entries()) {
        await service.grantCredits({
          accountId: account.id,
          amount: creditAmount("2"),
          expiresAt: expiresAt ? new Date(expiresAt) : undefined,
          ...metadata(`grant-${index}`),
        });
      }
      const spent = await service.consumeCredits({
        accountId: account.id,
        amount: creditAmount("6"),
        ...metadata("consume"),
      });
      now = new Date("2026-08-02T00:00:00.000Z");
      const refunded = await service.refundCredits({
        accountId: account.id,
        consumptionTransactionId: spent.transactions[0]!.id,
        amount: creditAmount("6"),
        ...metadata("refund"),
      });
      const transaction = refunded.transactions[0]!;
      expect(transaction.allocations).toEqual(spent.transactions[0]!.allocations);
      expect(transaction.grant?.expiresAt).toEqual(new Date(expectedExpiry));
      const [lot] = await db
        .select()
        .from(creditGrantLots)
        .where(eq(creditGrantLots.grantTransactionId, transaction.id));
      const [persisted] = await db
        .select()
        .from(creditTransactions)
        .where(eq(creditTransactions.id, transaction.id));
      expect(lot?.expiresAt).toEqual(new Date(expectedExpiry));
      expect(persisted?.grantExpiresAt).toEqual(new Date(expectedExpiry));
      const consumed = await service.consumeCredits({
        accountId: account.id,
        amount: creditAmount("6"),
        ...metadata("spend-refund"),
      });
      expect(consumed.transactions[0]?.allocations).toEqual([
        { grantTransactionId: transaction.id, amount: "6" },
      ]);
      expect(await service.getBalance(account.id)).toMatchObject({ available: "0", consumed: "6" });
    },
  );

  it("rolls back allocation changes and ledger appends when settlement validation fails", async () => {
    await reset();
    let sequence = 0;
    let publishedEvents = 0;
    const service = new CreditLedgerService({
      store: new DrizzleCreditLedgerStore(db, txManager),
      clock: () => new Date("2026-07-30T00:00:00.000Z"),
      idGenerator: () => `rollback-${++sequence}`,
      eventPublisher: {
        onAfterCommit(publish) {
          txManager.onAfterCommit(publish);
        },
        async publishIdempotently() {
          publishedEvents += 1;
        },
      },
    });
    const opened = await service.openAccount({
      tenantId: "tenant-rollback",
      idempotencyKey: "open-rollback",
      reference: { type: "test", id: "open-rollback" },
    });
    await service.grantCredits({
      accountId: opened.account.id,
      amount: creditAmount("10"),
      idempotencyKey: "grant-rollback",
      reference: { type: "test", id: "grant-rollback" },
    });
    const reserved = await service.reserveCredits({
      accountId: opened.account.id,
      amount: creditAmount("8"),
      idempotencyKey: "reserve-rollback",
      reference: { type: "test", id: "reserve-rollback" },
    });
    expect(reserved.reservation).toBeDefined();
    publishedEvents = 0;

    await expect(
      service.commitCredits({
        accountId: opened.account.id,
        reservationId: reserved.reservation!.id,
        amount: creditAmount("9"),
        idempotencyKey: "commit-invalid",
        reference: { type: "test", id: "commit-invalid" },
      }),
    ).rejects.toBeInstanceOf(CreditReservationMismatchProblem);

    expect(await service.getBalance(opened.account.id)).toEqual({
      accountId: opened.account.id,
      position: 2,
      available: "2",
      reserved: "8",
      consumed: "0",
      expired: "0",
      lifetimeGranted: "10",
      netAdjusted: "0",
    });
    expect((await service.getHistory(opened.account.id)).transactions).toHaveLength(2);
    expect(publishedEvents).toBe(0);
  });

  it("scopes repeated and conflicting idempotency keys to one tenant", async () => {
    await reset();
    let sequence = 0;
    const store = new DrizzleCreditLedgerStore(db, txManager);
    const service = new CreditLedgerService({
      store,
      idGenerator: () => `tenant-idempotency-${++sequence}`,
    });
    const [first, second] = await Promise.all([
      service.openAccount({
        tenantId: "tenant-idempotency-a",
        idempotencyKey: "open-tenant-idempotency-a",
        reference: { type: "test", id: "open-tenant-idempotency-a" },
      }),
      service.openAccount({
        tenantId: "tenant-idempotency-b",
        idempotencyKey: "open-tenant-idempotency-b",
        reference: { type: "test", id: "open-tenant-idempotency-b" },
      }),
    ]);
    const sharedInput = {
      amount: creditAmount("5"),
      idempotencyKey: "shared-tenant-idempotency-key",
      reference: { type: "test", id: "shared-tenant-idempotency-key" },
    };

    const [firstGrant, secondGrant] = await Promise.all([
      service.grantCredits({ ...sharedInput, accountId: first.account.id }),
      service.grantCredits({ ...sharedInput, accountId: second.account.id }),
    ]);

    expect(firstGrant.replayed).toBe(false);
    expect(secondGrant.replayed).toBe(false);
    expect(firstGrant.account.tenantId).toBe("tenant-idempotency-a");
    expect(secondGrant.account.tenantId).toBe("tenant-idempotency-b");
    await expect(
      service.grantCredits({ ...sharedInput, accountId: first.account.id }),
    ).resolves.toMatchObject({ replayed: true, account: { tenantId: "tenant-idempotency-a" } });
    await expect(
      service.grantCredits({
        ...sharedInput,
        accountId: first.account.id,
        amount: creditAmount("6"),
      }),
    ).rejects.toBeInstanceOf(CreditDuplicateConflictProblem);

    const intents = await store.listPendingEventIntents();
    expect(intents).toHaveLength(2);
    expect(new Set(intents.map((intent) => intent.eventId)).size).toBe(2);
  });

  it("isolates advisory locks for the same key across tenants", async () => {
    await reset();
    let sequence = 0;
    const service = new CreditLedgerService({
      store: new DrizzleCreditLedgerStore(db, txManager),
      idGenerator: () => `tenant-lock-${++sequence}`,
    });
    const [first, second] = await Promise.all([
      service.openAccount({
        tenantId: "tenant-lock-a",
        idempotencyKey: "open-tenant-lock-a",
        reference: { type: "test", id: "open-tenant-lock-a" },
      }),
      service.openAccount({
        tenantId: "tenant-lock-b",
        idempotencyKey: "open-tenant-lock-b",
        reference: { type: "test", id: "open-tenant-lock-b" },
      }),
    ]);
    const lockClient = await pool.connect();
    let blockedExecution: Promise<unknown> | undefined;
    try {
      await lockClient.query("begin");
      await lockClient.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        createCreditIdempotencyIdentity("tenant-lock-a", "shared-tenant-lock-key"),
      ]);
      blockedExecution = service.grantCredits({
        accountId: first.account.id,
        amount: creditAmount("1"),
        idempotencyKey: "shared-tenant-lock-key",
        reference: { type: "test", id: "shared-tenant-lock-key" },
      });
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const waiting = await pool.query<{ count: string }>(
          "select count(*) from pg_locks where locktype = 'advisory' and not granted",
        );
        if (waiting.rows[0]?.count !== "0") break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const waiting = await pool.query<{ count: string }>(
        "select count(*) from pg_locks where locktype = 'advisory' and not granted",
      );
      expect(Number(waiting.rows[0]?.count)).toBeGreaterThan(0);

      await expect(
        service.grantCredits({
          accountId: second.account.id,
          amount: creditAmount("1"),
          idempotencyKey: "shared-tenant-lock-key",
          reference: { type: "test", id: "shared-tenant-lock-key" },
        }),
      ).resolves.toMatchObject({ account: { tenantId: "tenant-lock-b" } });
    } finally {
      await lockClient.query("rollback");
      lockClient.release();
      await blockedExecution;
    }
  });

  it("migrates legacy global idempotency rows without losing replay or event intents", async () => {
    await reset();
    let sequence = 0;
    const store = new DrizzleCreditLedgerStore(db, txManager);
    const service = new CreditLedgerService({
      store,
      idGenerator: () => `tenant-migration-${++sequence}`,
    });
    const first = await service.openAccount({
      tenantId: "tenant-migration-a",
      idempotencyKey: "open-tenant-migration-a",
      reference: { type: "test", id: "open-tenant-migration-a" },
    });
    const legacyInput = {
      accountId: first.account.id,
      amount: creditAmount("3"),
      idempotencyKey: "legacy-global-idempotency-key",
      reference: { type: "test", id: "legacy-global-idempotency-key" },
    };
    await service.grantCredits(legacyInput);
    await db
      .update(creditLedgerEventIntents)
      .set({ eventId: "legacy-global-event-id" })
      .where(eq(creditLedgerEventIntents.idempotencyKey, legacyInput.idempotencyKey));
    const legacyIntent = await store.getPendingEventIntent(
      first.account.tenantId,
      legacyInput.idempotencyKey,
    );

    await db.execute(sql`
      alter table credit_ledger_event_intents
        drop constraint credit_ledger_event_intents_idempotency_fk
    `);
    await db.execute(sql`
      drop index credit_ledger_event_intents_idempotency_unique
    `);
    await db.execute(sql`
      alter table credit_idempotency_records
        drop constraint credit_idempotency_records_pkey
    `);
    await db.execute(sql`
      alter table credit_ledger_event_intents drop column tenant_id
    `);
    await db.execute(sql`
      alter table credit_idempotency_records drop column tenant_id
    `);
    await db.execute(sql`
      alter table credit_idempotency_records
        add constraint credit_idempotency_records_pkey primary key (key)
    `);
    await db.execute(sql`
      alter table credit_ledger_event_intents
        add constraint credit_ledger_event_intents_idempotency_key_fkey
          foreign key (idempotency_key) references credit_idempotency_records(key)
    `);
    await db.execute(sql`
      create unique index credit_ledger_event_intents_idempotency_unique
        on credit_ledger_event_intents(idempotency_key)
    `);

    await createCreditsSchema(db);

    const migratedRecords = await db
      .select({ tenantId: creditIdempotencyRecords.tenantId })
      .from(creditIdempotencyRecords)
      .where(eq(creditIdempotencyRecords.key, legacyInput.idempotencyKey));
    expect(migratedRecords).toEqual([{ tenantId: "tenant-migration-a" }]);
    await expect(service.grantCredits(legacyInput)).resolves.toMatchObject({ replayed: true });

    const second = await service.openAccount({
      tenantId: "tenant-migration-b",
      idempotencyKey: "open-tenant-migration-b",
      reference: { type: "test", id: "open-tenant-migration-b" },
    });
    await expect(
      service.grantCredits({ ...legacyInput, accountId: second.account.id }),
    ).resolves.toMatchObject({ replayed: false, account: { tenantId: "tenant-migration-b" } });
    const intents = await store.listPendingEventIntents();
    expect(intents).toHaveLength(2);
    expect(intents).toContainEqual(legacyIntent);
    expect(new Set(intents.map((intent) => intent.eventId)).size).toBe(2);
  });

  it("joins an ambient transaction so ledger writes and events disappear on rollback", async () => {
    await reset();
    let sequence = 0;
    const store = new DrizzleCreditLedgerStore(db, txManager);
    const setupService = new CreditLedgerService({
      store,
      idGenerator: () => `ambient-${++sequence}`,
    });
    const opened = await setupService.openAccount({
      tenantId: "tenant-ambient",
      idempotencyKey: "open-ambient",
      reference: { type: "test", id: "open-ambient" },
    });
    const publishedEvents: unknown[] = [];
    const service = new CreditLedgerService({
      store,
      idGenerator: () => `ambient-${++sequence}`,
      eventPublisher: {
        onAfterCommit(publish) {
          txManager.onAfterCommit(publish);
        },
        async publishIdempotently(event) {
          publishedEvents.push(event);
        },
      },
    });

    await expect(
      txManager.runWithOutcome(async () => {
        await service.grantCredits({
          accountId: opened.account.id,
          amount: creditAmount("4"),
          idempotencyKey: "grant-ambient-rollback",
          reference: { type: "test", id: "grant-ambient-rollback" },
        });
        throw new Error("force outer rollback");
      }),
    ).rejects.toThrow("force outer rollback");

    expect(publishedEvents).toHaveLength(0);
    expect(await setupService.getBalance(opened.account.id)).toMatchObject({
      position: 0,
      available: "0",
      lifetimeGranted: "0",
    });
    expect((await setupService.getHistory(opened.account.id)).transactions).toHaveLength(0);
  });

  it("recovers a committed event intent after restart without applying the ledger twice", async () => {
    await reset();
    let sequence = 0;
    const firstStore = new DrizzleCreditLedgerStore(db, txManager);
    const firstProcess = new CreditLedgerService({
      store: firstStore,
      clock: () => new Date("2026-07-30T00:00:00.000Z"),
      idGenerator: () => `restart-${++sequence}`,
    });
    const opened = await firstProcess.openAccount({
      tenantId: "tenant-restart",
      idempotencyKey: "restart-open",
      reference: { type: "test", id: "restart-open" },
    });
    const input = {
      accountId: opened.account.id,
      amount: creditAmount("7"),
      idempotencyKey: "restart-grant",
      reference: { type: "test", id: "restart-grant" },
    };
    await firstProcess.grantCredits(input);

    const pendingBeforeRestart = await firstStore.getPendingEventIntent(
      opened.account.tenantId,
      input.idempotencyKey,
    );
    expect(pendingBeforeRestart?.eventId).toMatch(/^[a-f0-9]{64}$/);

    const publishedEvents: Array<{ eventId: string }> = [];
    let publicationAcknowledgement: Promise<void> | undefined;
    const restartedStore = new DrizzleCreditLedgerStore(db, txManager);
    const restartedProcess = new CreditLedgerService({
      store: restartedStore,
      clock: () => new Date("2026-07-30T00:01:00.000Z"),
      idGenerator: () => `restarted-${++sequence}`,
      eventPublisher: {
        onAfterCommit(publish) {
          publicationAcknowledgement = publish();
        },
        async publishIdempotently(event) {
          publishedEvents.push({ eventId: event.eventId });
        },
      },
    });

    await expect(restartedProcess.grantCredits(input)).resolves.toMatchObject({ replayed: true });
    await publicationAcknowledgement;
    expect(publishedEvents).toEqual([{ eventId: pendingBeforeRestart?.eventId }]);
    await expect(
      restartedStore.getPendingEventIntent(opened.account.tenantId, input.idempotencyKey),
    ).resolves.toBeNull();
    await expect(restartedProcess.getBalance(opened.account.id)).resolves.toMatchObject({
      position: 1,
      available: "7",
    });
    expect((await restartedProcess.getHistory(opened.account.id)).transactions).toHaveLength(1);
  });

  it("backfills legacy committed rows as pending intents with reconstructable evidence", async () => {
    await reset();
    let sequence = 0;
    const store = new DrizzleCreditLedgerStore(db, txManager);
    const service = new CreditLedgerService({
      store,
      clock: () => new Date("2026-07-30T02:00:00.000Z"),
      idGenerator: () => `legacy-${++sequence}`,
    });
    const opened = await service.openAccount({
      tenantId: "tenant-legacy-한글",
      idempotencyKey: "legacy-open",
      reference: { type: "test", id: "legacy-open" },
    });
    const granted = await service.grantCredits({
      accountId: opened.account.id,
      amount: creditAmount("9"),
      idempotencyKey: "legacy-grant",
      reference: { type: "legacy-recovery", id: "legacy-grant" },
    });
    const originalIntent = await store.getPendingEventIntent("tenant-legacy-한글", "legacy-grant");
    await db
      .delete(creditLedgerEventIntents)
      .where(eq(creditLedgerEventIntents.idempotencyKey, "legacy-grant"));

    await createCreditsSchema(db);

    const intent = await store.getPendingEventIntent("tenant-legacy-한글", "legacy-grant");
    expect(intent).toEqual({
      eventId: originalIntent?.eventId,
      tenantId: "tenant-legacy-한글",
      idempotencyKey: "legacy-grant",
      occurredAt: new Date("2026-07-30T02:00:00.000Z"),
      data: {
        accountId: opened.account.id,
        position: 1,
        transactionIds: [granted.transactions[0]?.id],
        kinds: ["grant"],
        reference: { type: "legacy-recovery", id: "legacy-grant" },
      },
    });
  });

  it("repairs a rollout-gap intent on replay without repeating the ledger movement", async () => {
    await reset();
    let sequence = 0;
    const store = new DrizzleCreditLedgerStore(db, txManager);
    const producer = new CreditLedgerService({
      store,
      clock: () => new Date("2026-07-30T03:00:00.000Z"),
      idGenerator: () => `rollout-${++sequence}`,
    });
    const opened = await producer.openAccount({
      tenantId: "tenant-rollout-gap",
      idempotencyKey: "rollout-open",
      reference: { type: "test", id: "rollout-open" },
    });
    const input = {
      accountId: opened.account.id,
      amount: creditAmount("11"),
      idempotencyKey: "rollout-grant",
      reference: { type: "rollout-gap", id: "rollout-grant" },
    };
    const granted = await producer.grantCredits(input);
    await db
      .delete(creditLedgerEventIntents)
      .where(eq(creditLedgerEventIntents.idempotencyKey, input.idempotencyKey));

    const replay = await producer.grantCredits(input);

    expect(replay.replayed).toBe(true);
    await expect(
      store.getPendingEventIntent(opened.account.tenantId, input.idempotencyKey),
    ).resolves.toMatchObject({
      occurredAt: granted.transactions[0]?.occurredAt,
      data: {
        transactionIds: [granted.transactions[0]?.id],
        reference: input.reference,
      },
    });
    await expect(producer.getBalance(opened.account.id)).resolves.toMatchObject({
      position: 1,
      available: "11",
    });
    expect((await producer.getHistory(opened.account.id)).transactions).toHaveLength(1);
  });

  it("rejects reservation references that cross account boundaries", async () => {
    await reset();
    let sequence = 0;
    const service = new CreditLedgerService({
      store: new DrizzleCreditLedgerStore(db, txManager),
      idGenerator: () => `tenant-boundary-${++sequence}`,
    });
    const first = await service.openAccount({
      tenantId: "tenant-boundary-a",
      idempotencyKey: "open-boundary-a",
      reference: { type: "test", id: "open-boundary-a" },
    });
    const second = await service.openAccount({
      tenantId: "tenant-boundary-b",
      idempotencyKey: "open-boundary-b",
      reference: { type: "test", id: "open-boundary-b" },
    });
    const firstGrant = await service.grantCredits({
      accountId: first.account.id,
      amount: creditAmount("5"),
      idempotencyKey: "grant-boundary",
      reference: { type: "test", id: "grant-boundary" },
    });
    const secondGrant = await service.grantCredits({
      accountId: second.account.id,
      amount: creditAmount("5"),
      idempotencyKey: "grant-boundary-second",
      reference: { type: "test", id: "grant-boundary-second" },
    });
    const reserved = await service.reserveCredits({
      accountId: first.account.id,
      amount: creditAmount("2"),
      idempotencyKey: "reserve-boundary",
      reference: { type: "test", id: "reserve-boundary" },
    });
    expect(reserved.reservation).toBeDefined();

    await expect(
      service.getReservation(second.account.id, reserved.reservation!.id),
    ).rejects.toBeInstanceOf(CreditAccountMismatchProblem);
    await expect(
      db.execute(sql`
        insert into credit_reservation_allocations (
          reservation_id,
          grant_transaction_id,
          account_id,
          amount,
          ordinal
        ) values (
          ${reserved.reservation!.id},
          ${secondGrant.transactions[0]!.id},
          ${first.account.id},
          1,
          99
        )
      `),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`
        insert into credit_transactions (
          id,
          account_id,
          position,
          kind,
          amount,
          occurred_at,
          idempotency_key,
          reference_type,
          reference_id,
          reservation_id
        ) values (
          'cross-account-reservation',
          ${second.account.id},
          2,
          'commit',
          1,
          now(),
          'cross-account-reservation',
          'test',
          'cross-account-reservation',
          ${reserved.reservation!.id}
        )
      `),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`
        insert into credit_transactions (
          id,
          account_id,
          position,
          kind,
          amount,
          occurred_at,
          idempotency_key,
          reference_type,
          reference_id,
          related_transaction_id
        ) values (
          'cross-account-related',
          ${second.account.id},
          2,
          'refund',
          1,
          now(),
          'cross-account-related',
          'test',
          'cross-account-related',
          ${firstGrant.transactions[0]!.id}
        )
      `),
    ).rejects.toThrow();
  });
});
