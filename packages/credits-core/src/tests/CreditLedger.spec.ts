import {
  type DomainEvent,
  EventAfterCommitOutcomeRequiredProblem,
  EventAfterCommitRequiresActiveTransactionProblem,
} from "@croco/events-core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addCreditAmounts,
  CreditAccountMismatchProblem,
  CreditDuplicateConflictProblem,
  CreditEventPublicationProblem,
  type CreditLedgerCommand,
  CreditLedgerCommittedEvent,
  CreditLedgerService,
  compareCreditAmounts,
  createCreditLedgerStoreConformanceSuite,
  creditAmount,
  ExpiredGrantProblem,
  InMemoryCreditLedgerStore,
  InsufficientCreditsProblem,
  InvalidCreditAmountProblem,
  InvalidCreditCommandProblem,
  StaleLedgerPositionProblem,
  subtractCreditAmounts,
} from "../index";

describe("InMemoryCreditLedgerStore conformance", () => {
  const suite = createCreditLedgerStoreConformanceSuite({
    storeName: "in-memory",
    createStore: () => new InMemoryCreditLedgerStore(),
  });

  for (const testCase of suite.cases) {
    // oxlint-disable-next-line jest/valid-title -- exported conformance cases own stable names
    it(testCase.name, testCase.run);
  }
});

describe("InMemoryCreditLedgerStore reservation expiry", () => {
  let store: InMemoryCreditLedgerStore;
  let service: CreditLedgerService;
  let now: Date;
  const expiresAt = new Date("2026-07-27T00:00:00.000Z");
  const metadata = (id: string) => ({
    idempotencyKey: id,
    reference: { type: "reservation-expiry", id },
  });

  beforeEach(() => {
    let sequence = 0;
    now = new Date("2026-07-26T00:00:00.000Z");
    store = new InMemoryCreditLedgerStore();
    service = new CreditLedgerService({
      store,
      eventDelivery: "development",
      clock: () => now,
      idGenerator: () => `expiry-id-${++sequence}`,
    });
  });

  it.each([
    {
      operation: "commit",
      reservedAmount: "6",
      initiallyExpired: "4",
      remainder: "2",
      consumed: "4",
    },
    {
      operation: "release",
      reservedAmount: "6",
      initiallyExpired: "4",
      remainder: "6",
      consumed: "0",
    },
    {
      operation: "commit",
      reservedAmount: "10",
      initiallyExpired: "0",
      remainder: "6",
      consumed: "4",
    },
    {
      operation: "release",
      reservedAmount: "10",
      initiallyExpired: "0",
      remainder: "10",
      consumed: "0",
    },
  ] as const)(
    "settles $operation after sweeping a lot with $reservedAmount reserved credits",
    async ({ operation, reservedAmount, initiallyExpired, remainder, consumed }) => {
      const opened = await service.openAccount({ tenantId: "tenant-expiry", ...metadata("open") });
      const accountId = opened.account.id;
      const granted = await service.grantCredits({
        accountId,
        amount: creditAmount("10"),
        expiresAt,
        ...metadata("grant"),
      });
      const reserved = await service.reserveCredits({
        accountId,
        amount: creditAmount(reservedAmount),
        ...metadata("reserve"),
      });
      const reservationId = reserved.reservation?.id;
      expect(reservationId).toBeDefined();
      if (!reservationId) throw new InvalidCreditCommandProblem("test reservation is missing");

      now = new Date(expiresAt);
      const firstSweep = await service.expireCredits({ accountId, ...metadata("first-sweep") });
      expect(firstSweep.transactions.map(({ kind, amount }) => ({ kind, amount }))).toEqual(
        initiallyExpired === "0" ? [] : [{ kind: "expire", amount: initiallyExpired }],
      );
      const beforeSettlement = await service.getBalance(accountId);
      expect(beforeSettlement).toMatchObject({
        available: "0",
        reserved: reservedAmount,
        consumed: "0",
        expired: initiallyExpired,
      });

      const input = { accountId, reservationId, ...metadata("settle") };
      const settle = () =>
        operation === "commit"
          ? service.commitCredits({ ...input, amount: creditAmount("4") })
          : service.releaseCredits(input);
      const settled = await settle();
      expect(settled.reservation).toMatchObject({
        status: operation === "commit" ? "committed" : "released",
        settledAt: expiresAt,
      });
      expect(settled.transactions.map(({ kind, amount }) => ({ kind, amount }))).toEqual([
        ...(operation === "commit" ? [{ kind: "commit", amount: "4" }] : []),
        { kind: "release", amount: remainder },
      ]);
      expect(settled.transactions.at(-1)?.allocations).toEqual([
        { grantTransactionId: granted.transactions[0]?.id, amount: remainder },
      ]);
      const afterSettlement = await service.getBalance(accountId);
      expect(afterSettlement).toMatchObject({
        available: remainder,
        reserved: "0",
        consumed,
        expired: initiallyExpired,
      });
      await expect(service.getBalance(accountId, beforeSettlement.position)).resolves.toEqual(
        beforeSettlement,
      );
      await expect(settle()).resolves.toEqual({ ...settled, replayed: true });
      await expect(service.getBalance(accountId)).resolves.toEqual(afterSettlement);
      await expect(store.getPendingEventIntent("tenant-expiry", "settle")).resolves.toMatchObject({
        data: {
          position: settled.account.position,
          transactionIds: settled.transactions.map(({ id }) => id),
        },
      });

      for (const allocate of [
        () =>
          service.reserveCredits({
            accountId,
            amount: creditAmount("1"),
            ...metadata("reserve-expired"),
          }),
        () =>
          service.consumeCredits({
            accountId,
            amount: creditAmount("1"),
            ...metadata("consume-expired"),
          }),
      ]) {
        await expect(allocate()).rejects.toThrow(ExpiredGrantProblem);
        await expect(service.getBalance(accountId)).resolves.toEqual(afterSettlement);
      }

      const finalSweep = await service.expireCredits({ accountId, ...metadata("final-sweep") });
      expect(finalSweep.transactions).toMatchObject([
        {
          kind: "expire",
          amount: remainder,
          allocations: [{ grantTransactionId: granted.transactions[0]?.id, amount: remainder }],
        },
      ]);
      const finalBalance = await service.getBalance(accountId);
      expect(finalBalance).toMatchObject({
        available: "0",
        reserved: "0",
        consumed,
        expired: operation === "commit" ? "6" : "10",
        lifetimeGranted: "10",
      });
      await expect(service.getBalance(accountId, afterSettlement.position)).resolves.toEqual(
        afterSettlement,
      );
      await expect(
        service.expireCredits({ accountId, ...metadata("final-sweep") }),
      ).resolves.toEqual({
        ...finalSweep,
        replayed: true,
      });
      expect(
        (await service.expireCredits({ accountId, ...metadata("empty-sweep") })).transactions,
      ).toEqual([]);
      await expect(service.getBalance(accountId)).resolves.toEqual(finalBalance);
    },
  );

  it.each(["commit", "release"] as const)(
    "restores active allocations separately from expired allocations during %s",
    async (operation) => {
      const opened = await service.openAccount({ tenantId: "tenant-mixed", ...metadata("open") });
      const accountId = opened.account.id;
      const expiring = await service.grantCredits({
        accountId,
        amount: creditAmount("10"),
        expiresAt,
        ...metadata("expiring-grant"),
      });
      const active = await service.grantCredits({
        accountId,
        amount: creditAmount("10"),
        expiresAt: new Date("2026-07-29T00:00:00.000Z"),
        ...metadata("active-grant"),
      });
      const reserved = await service.reserveCredits({
        accountId,
        amount: creditAmount("15"),
        ...metadata("reserve"),
      });
      const reservationId = reserved.reservation?.id;
      expect(reservationId).toBeDefined();
      if (!reservationId) throw new InvalidCreditCommandProblem("test reservation is missing");

      now = new Date("2026-07-28T00:00:00.000Z");
      expect(
        (await service.expireCredits({ accountId, ...metadata("first-sweep") })).transactions,
      ).toEqual([]);
      const input = { accountId, reservationId, ...metadata("settle") };
      const settled = await (operation === "commit"
        ? service.commitCredits({ ...input, amount: creditAmount("4") })
        : service.releaseCredits(input));
      const expiredRemainder = operation === "commit" ? "6" : "10";
      expect(settled.transactions.at(-1)?.allocations).toEqual([
        { grantTransactionId: expiring.transactions[0]?.id, amount: expiredRemainder },
        { grantTransactionId: active.transactions[0]?.id, amount: "5" },
      ]);
      const swept = await service.expireCredits({ accountId, ...metadata("final-sweep") });
      expect(swept.transactions).toMatchObject([
        {
          kind: "expire",
          amount: expiredRemainder,
          allocations: [{ grantTransactionId: expiring.transactions[0]?.id }],
        },
      ]);
      expect(await service.getBalance(accountId)).toMatchObject({
        available: "10",
        reserved: "0",
        consumed: operation === "commit" ? "4" : "0",
        expired: expiredRemainder,
        lifetimeGranted: "20",
      });
      const consumed = await service.consumeCredits({
        accountId,
        amount: creditAmount("10"),
        ...metadata("consume-active"),
      });
      expect(consumed.transactions[0]?.allocations).toEqual([
        { grantTransactionId: active.transactions[0]?.id, amount: "10" },
      ]);
      expect(await service.getBalance(accountId)).toMatchObject({ available: "0", reserved: "0" });
    },
  );
});

describe("CreditAmount", () => {
  it("normalizes exact base-10 values without floating-point conversion", () => {
    expect(creditAmount("1.2300")).toBe("1.23");
  });

  it("keeps exact arithmetic across different scales and large integers", () => {
    const sum = addCreditAmounts(
      creditAmount("9007199254740993.000000000000000001"),
      creditAmount("0.999999999999999999"),
    );

    expect(sum).toBe("9007199254740994");
    expect(subtractCreditAmounts(sum, creditAmount("0.000000000000000001"))).toBe(
      "9007199254740993.999999999999999999",
    );
    expect(compareCreditAmounts(creditAmount("1.20"), creditAmount("1.2"))).toBe(0);
  });

  it.each(["0", "-1", "NaN", "Infinity", "1e3", "1.0000000000000000001"])(
    "rejects invalid or non-positive command amount %s",
    (value) => {
      expect(() => creditAmount(value)).toThrow(InvalidCreditAmountProblem);
    },
  );

  it("rejects JavaScript numbers at runtime before floating-point artifacts enter the ledger", () => {
    expect(() => creditAmount((0.1 + 0.2) as never)).toThrow(InvalidCreditAmountProblem);
  });
});

describe("CreditLedgerService", () => {
  let sequence!: number;
  let store!: InMemoryCreditLedgerStore;
  let service!: CreditLedgerService;

  const ref = (id: string) => ({ type: "test", id });

  beforeEach(() => {
    sequence = 0;
    store = new InMemoryCreditLedgerStore();
    service = new CreditLedgerService({
      store,
      eventDelivery: "development",
      clock: () => new Date("2026-07-26T12:00:00.000Z"),
      idGenerator: () => `id-${++sequence}`,
    });
  });

  it("requires volatile stores to be selected explicitly for development", () => {
    expect(() => new CreditLedgerService({ store })).toThrow(InvalidCreditCommandProblem);
  });

  it("publishes a stable ledger event only after the store command commits", async () => {
    let commandCommitted = false;
    class ObservedStore extends InMemoryCreditLedgerStore {
      override async execute(command: CreditLedgerCommand) {
        const result = await super.execute(command);
        commandCommitted = true;
        return result;
      }
    }

    const events: DomainEvent[] = [];
    service = new CreditLedgerService({
      store: new ObservedStore(),
      eventDelivery: "development",
      clock: () => new Date("2026-07-26T12:00:00.000Z"),
      idGenerator: () => `event-id-${++sequence}`,
      eventPublisher: {
        onAfterCommit() {
          throw new EventAfterCommitRequiresActiveTransactionProblem();
        },
        async publishIdempotently(event) {
          expect(commandCommitted).toBe(true);
          events.push(event);
        },
      },
    });

    const opened = await service.openAccount({
      tenantId: "tenant-event",
      idempotencyKey: "event-open",
      reference: ref("event-open"),
    });
    commandCommitted = false;
    const granted = await service.grantCredits({
      accountId: opened.account.id,
      amount: creditAmount("10"),
      idempotencyKey: "event-grant",
      reference: ref("event-grant"),
    });
    commandCommitted = false;
    await service.grantCredits({
      accountId: opened.account.id,
      amount: creditAmount("10"),
      idempotencyKey: "event-grant",
      reference: ref("event-grant"),
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.eventId).toMatch(/^[a-f0-9]{64}$/);
    expect(events[0]?.timestamp).toEqual(new Date("2026-07-26T12:00:00.000Z"));
    expect(events[0]).toBeInstanceOf(CreditLedgerCommittedEvent);
    expect((events[0] as CreditLedgerCommittedEvent).data).toEqual({
      accountId: opened.account.id,
      position: 1,
      transactionIds: [granted.transactions[0]?.id],
      kinds: ["grant"],
      reference: ref("event-grant"),
    });
  });

  it("reports committed command success while a retained event intent is retried", async () => {
    const published: DomainEvent[] = [];
    let publicationAttempts = 0;
    service = new CreditLedgerService({
      store,
      eventDelivery: "development",
      clock: () => new Date("2026-07-26T12:00:00.000Z"),
      idGenerator: () => `retry-event-id-${++sequence}`,
      eventPublisher: {
        onAfterCommit() {
          throw new EventAfterCommitRequiresActiveTransactionProblem();
        },
        async publishIdempotently(event) {
          publicationAttempts++;
          if (publicationAttempts === 1) {
            throw new InvalidCreditAmountProblem("simulated event transport failure");
          }
          published.push(event);
        },
      },
    });
    const opened = await service.openAccount({
      tenantId: "tenant-event-retry",
      idempotencyKey: "event-retry-open",
      reference: ref("event-retry-open"),
    });
    const grantInput = {
      accountId: opened.account.id,
      amount: creditAmount("5"),
      idempotencyKey: "event-retry-grant",
      reference: ref("event-retry-grant"),
    };

    await expect(service.grantCredits(grantInput)).resolves.toMatchObject({ replayed: false });
    expect(await service.getBalance(opened.account.id)).toMatchObject({
      position: 1,
      available: "5",
    });
    expect(await store.listPendingEventIntents()).toHaveLength(1);
    const restartedService = new CreditLedgerService({
      store,
      eventDelivery: "development",
      clock: () => new Date("2026-07-26T12:00:00.000Z"),
      idGenerator: () => `restarted-event-id-${++sequence}`,
      eventPublisher: {
        onAfterCommit() {
          throw new EventAfterCommitRequiresActiveTransactionProblem();
        },
        async publishIdempotently(event) {
          publicationAttempts++;
          published.push(event);
        },
      },
    });
    await expect(restartedService.grantCredits(grantInput)).resolves.toMatchObject({
      replayed: true,
    });

    expect(publicationAttempts).toBe(2);
    expect(published).toHaveLength(1);
    expect(published[0]?.eventId).toMatch(/^[a-f0-9]{64}$/);
    expect(published[0]?.timestamp).toEqual(new Date("2026-07-26T12:00:00.000Z"));
    expect(await store.listPendingEventIntents()).toHaveLength(0);
    expect(await service.getBalance(opened.account.id)).toMatchObject({
      position: 1,
      available: "5",
    });
  });

  it("keeps the intent pending when the ambient transaction cannot report after-commit outcomes", async () => {
    const opened = await service.openAccount({
      tenantId: "tenant-event-outcome",
      idempotencyKey: "event-outcome-open",
      reference: ref("event-outcome-open"),
    });
    service = new CreditLedgerService({
      store,
      eventDelivery: "development",
      clock: () => new Date("2026-07-26T12:00:00.000Z"),
      idGenerator: () => `outcome-event-id-${++sequence}`,
      eventPublisher: {
        onAfterCommit() {
          throw new EventAfterCommitOutcomeRequiredProblem();
        },
        async publishIdempotently() {
          throw new InvalidCreditAmountProblem("unexpected pre-commit publication");
        },
      },
    });

    await expect(
      service.grantCredits({
        accountId: opened.account.id,
        amount: creditAmount("3"),
        idempotencyKey: "event-outcome-grant",
        reference: ref("event-outcome-grant"),
      }),
    ).resolves.toMatchObject({ replayed: false });
    expect(await store.listPendingEventIntents()).toHaveLength(1);
  });

  it("keeps scheduled intent pending until the after-commit callback publishes", async () => {
    const publications: Array<() => Promise<void>> = [];
    let published = 0;
    service = new CreditLedgerService({
      store,
      eventDelivery: "development",
      clock: () => new Date("2026-07-26T12:00:00.000Z"),
      idGenerator: () => `scheduled-event-id-${++sequence}`,
      eventPublisher: {
        onAfterCommit(publish) {
          publications.push(publish);
        },
        async publishIdempotently() {
          published++;
        },
      },
    });
    const opened = await service.openAccount({
      tenantId: "tenant-scheduled-event",
      idempotencyKey: "scheduled-event-open",
      reference: ref("scheduled-event-open"),
    });
    const input = {
      accountId: opened.account.id,
      amount: creditAmount("2"),
      idempotencyKey: "scheduled-event-grant",
      reference: ref("scheduled-event-grant"),
    };

    await service.grantCredits(input);
    await service.grantCredits(input);
    expect(publications).toHaveLength(2);

    expect(published).toBe(0);
    await publications[1]?.();
    await publications[0]?.();
    expect(published).toBe(1);
    await service.grantCredits(input);
    expect(publications).toHaveLength(2);
    expect(await service.getBalance(opened.account.id)).toMatchObject({
      position: 1,
      available: "2",
    });
  });

  it("retains every development event intent under queue pressure", async () => {
    const producer = new CreditLedgerService({
      store,
      eventDelivery: "development",
      clock: () => new Date("2026-07-26T12:00:00.000Z"),
      idGenerator: () => `bounded-event-id-${++sequence}`,
    });
    const opened = await producer.openAccount({
      tenantId: "tenant-bounded-event",
      idempotencyKey: "bounded-event-open",
      reference: ref("bounded-event-open"),
    });

    for (const id of ["first", "second"]) {
      await producer.grantCredits({
        accountId: opened.account.id,
        amount: creditAmount("1"),
        idempotencyKey: `bounded-event-${id}`,
        reference: ref(`bounded-event-${id}`),
      });
    }

    const published: DomainEvent[] = [];
    const recovery = new CreditLedgerService({
      store,
      eventDelivery: "development",
      eventPublisher: {
        onAfterCommit() {
          throw new InvalidCreditAmountProblem("unexpected scheduled publication");
        },
        async publishIdempotently(event) {
          published.push(event);
        },
      },
    });
    await expect(recovery.publishPendingEvents()).resolves.toBe(2);
    expect(published).toHaveLength(2);
    await expect(recovery.publishPendingEvents()).resolves.toBe(0);
    expect(await service.getBalance(opened.account.id)).toMatchObject({
      position: 2,
      available: "2",
    });
  });

  it("fails instead of reporting a drained queue without a publisher", async () => {
    await expect(service.publishPendingEvents()).rejects.toThrow(InvalidCreditCommandProblem);
  });

  it("rejects expired and meter-restricted grants before balance movement", async () => {
    const opened = await service.openAccount({
      tenantId: "tenant-restricted",
      idempotencyKey: "restricted-open",
      reference: ref("restricted-open"),
    });
    await service.grantCredits({
      accountId: opened.account.id,
      amount: creditAmount("10"),
      expiresAt: new Date("2026-07-25T00:00:00.000Z"),
      meterKeys: ["tokens"],
      idempotencyKey: "restricted-grant",
      reference: ref("restricted-grant"),
    });

    await expect(
      service.consumeCredits({
        accountId: opened.account.id,
        amount: creditAmount("1"),
        meterKey: "tokens",
        idempotencyKey: "restricted-consume-expired",
        reference: ref("restricted-consume-expired"),
      }),
    ).rejects.toThrow(ExpiredGrantProblem);
    expect(await service.getBalance(opened.account.id)).toMatchObject({
      position: 1,
      available: "10",
      consumed: "0",
    });
  });

  it("reports insufficient credits when expired lots still cannot fund the request", async () => {
    const opened = await service.openAccount({
      tenantId: "tenant-expired-shortfall",
      idempotencyKey: "expired-shortfall-open",
      reference: ref("expired-shortfall-open"),
    });
    await service.grantCredits({
      accountId: opened.account.id,
      amount: creditAmount("1"),
      expiresAt: new Date("2026-07-25T00:00:00.000Z"),
      idempotencyKey: "expired-shortfall-grant",
      reference: ref("expired-shortfall-grant"),
    });

    await expect(
      service.consumeCredits({
        accountId: opened.account.id,
        amount: creditAmount("1000"),
        idempotencyKey: "expired-shortfall-consume",
        reference: ref("expired-shortfall-consume"),
      }),
    ).rejects.toThrow(InsufficientCreditsProblem);
  });

  it("enforces expected position when reopening an existing tenant wallet", async () => {
    const opened = await service.openAccount({
      tenantId: "tenant-reopen",
      walletKey: "primary",
      idempotencyKey: "reopen-first",
      reference: ref("reopen-first"),
    });
    await service.grantCredits({
      accountId: opened.account.id,
      amount: creditAmount("1"),
      idempotencyKey: "reopen-grant",
      reference: ref("reopen-grant"),
    });

    await expect(
      service.openAccount({
        tenantId: "tenant-reopen",
        walletKey: "primary",
        expectedPosition: 0,
        idempotencyKey: "reopen-stale",
        reference: ref("reopen-stale"),
      }),
    ).rejects.toThrow(StaleLedgerPositionProblem);
    await expect(
      service.openAccount({
        tenantId: "tenant-reopen",
        walletKey: "primary",
        expectedPosition: 1,
        idempotencyKey: "reopen-current",
        reference: ref("reopen-current"),
      }),
    ).resolves.toMatchObject({
      account: { id: opened.account.id, position: 1 },
      replayed: true,
    });
  });

  it("reports cross-account reservation and transaction references explicitly", async () => {
    const first = await service.openAccount({
      tenantId: "tenant-a",
      idempotencyKey: "account-a",
      reference: ref("account-a"),
    });
    const second = await service.openAccount({
      tenantId: "tenant-b",
      idempotencyKey: "account-b",
      reference: ref("account-b"),
    });
    await service.grantCredits({
      accountId: first.account.id,
      amount: creditAmount("10"),
      idempotencyKey: "account-a-grant",
      reference: ref("account-a-grant"),
    });
    const reserved = await service.reserveCredits({
      accountId: first.account.id,
      amount: creditAmount("4"),
      idempotencyKey: "account-a-reserve",
      reference: ref("account-a-reserve"),
    });
    const reservation = reserved.reservation;
    expect(reservation).toBeDefined();
    if (!reservation) {
      throw new InvalidCreditAmountProblem("test reservation was not returned");
    }

    await expect(
      service.releaseCredits({
        accountId: second.account.id,
        reservationId: reservation.id,
        idempotencyKey: "cross-account-release",
        reference: ref("cross-account-release"),
      }),
    ).rejects.toThrow(CreditAccountMismatchProblem);
  });

  it("keeps historical queries pinned to an explicit ledger position", async () => {
    const opened = await service.openAccount({
      tenantId: "tenant-history",
      idempotencyKey: "history-open",
      reference: ref("history-open"),
    });
    await service.grantCredits({
      accountId: opened.account.id,
      amount: creditAmount("10"),
      idempotencyKey: "history-grant",
      reference: ref("history-grant"),
    });
    await service.consumeCredits({
      accountId: opened.account.id,
      amount: creditAmount("3"),
      idempotencyKey: "history-consume",
      reference: ref("history-consume"),
    });

    expect(await service.getBalance(opened.account.id, 1)).toMatchObject({
      position: 1,
      available: "10",
      consumed: "0",
    });
    expect(await service.getHistory(opened.account.id, { atPosition: 1 })).toMatchObject({
      position: 1,
      transactions: [{ kind: "grant", position: 1 }],
    });
    await expect(service.getBalance(opened.account.id, 3)).rejects.toThrow(
      StaleLedgerPositionProblem,
    );
  });

  it("rejects colliding generated IDs before any allocation mutates", async () => {
    const opened = await service.openAccount({
      tenantId: "tenant-id-collision",
      idempotencyKey: "collision-open",
      reference: ref("collision-open"),
    });
    await service.grantCredits({
      accountId: opened.account.id,
      amount: creditAmount("10"),
      idempotencyKey: "collision-grant",
      reference: ref("collision-grant"),
    });
    const collidingService = new CreditLedgerService({
      store,
      eventDelivery: "development",
      clock: () => new Date("2026-07-26T12:00:00.000Z"),
      idGenerator: () => "id-2",
    });

    await expect(
      collidingService.reserveCredits({
        accountId: opened.account.id,
        amount: creditAmount("5"),
        idempotencyKey: "collision-reserve",
        reference: ref("collision-reserve"),
      }),
    ).rejects.toThrow(InvalidCreditCommandProblem);
    expect(await service.getBalance(opened.account.id)).toMatchObject({
      position: 1,
      available: "10",
      reserved: "0",
    });
  });

  it("enforces canonical decimal strings again at the command boundary", async () => {
    const opened = await service.openAccount({
      tenantId: "tenant-unsafe-amount",
      idempotencyKey: "unsafe-amount-open",
      reference: ref("unsafe-amount-open"),
    });
    const baseInput = {
      accountId: opened.account.id,
      idempotencyKey: "unsafe-amount-grant",
      reference: ref("unsafe-amount-grant"),
    };

    await expect(
      service.grantCredits({
        ...baseInput,
        amount: (0.1 + 0.2) as never,
      }),
    ).rejects.toThrow(InvalidCreditAmountProblem);
    await expect(
      service.grantCredits({
        ...baseInput,
        amount: "1.00" as never,
      }),
    ).rejects.toThrow(InvalidCreditAmountProblem);
    expect(await service.getBalance(opened.account.id)).toMatchObject({
      position: 0,
      available: "0",
    });
  });

  it("preserves projection conservation across a deterministic hostile sequence", async () => {
    const opened = await service.openAccount({
      tenantId: "tenant-property",
      idempotencyKey: "property-open",
      reference: ref("property-open"),
    });

    for (let index = 1; index <= 25; index++) {
      await service.grantCredits({
        accountId: opened.account.id,
        amount: creditAmount("10"),
        idempotencyKey: `property-grant-${index}`,
        reference: ref(`property-grant-${index}`),
      });
      const reserved = await service.reserveCredits({
        accountId: opened.account.id,
        amount: creditAmount("6"),
        idempotencyKey: `property-reserve-${index}`,
        reference: ref(`property-reserve-${index}`),
      });
      const reservation = reserved.reservation;
      expect(reservation).toBeDefined();
      if (!reservation) {
        throw new InvalidCreditAmountProblem("test reservation was not returned");
      }
      await service.commitCredits({
        accountId: opened.account.id,
        reservationId: reservation.id,
        amount: creditAmount("4"),
        idempotencyKey: `property-commit-${index}`,
        reference: ref(`property-commit-${index}`),
      });

      const balance = await service.getBalance(opened.account.id);
      expect(
        addCreditAmounts(
          addCreditAmounts(balance.available, balance.reserved),
          addCreditAmounts(balance.consumed, balance.expired),
        ),
      ).toBe(balance.lifetimeGranted);
      expect(balance.position).toBe(index * 4);
    }

    expect(await service.getBalance(opened.account.id)).toMatchObject({
      available: "150",
      reserved: "0",
      consumed: "100",
      expired: "0",
      lifetimeGranted: "250",
    });
  });

  it("keeps idempotency conflicts stable after time advances", async () => {
    let now = new Date("2026-07-26T00:00:00.000Z");
    service = new CreditLedgerService({
      store,
      eventDelivery: "development",
      clock: () => now,
      idGenerator: () => `replay-id-${++sequence}`,
    });
    const opened = await service.openAccount({
      tenantId: "tenant-time-replay",
      idempotencyKey: "time-open",
      reference: ref("time-open"),
    });
    const input = {
      accountId: opened.account.id,
      amount: creditAmount("1"),
      idempotencyKey: "time-grant",
      reference: ref("time-grant"),
    };
    await service.grantCredits(input);
    now = new Date("2026-07-27T00:00:00.000Z");

    await expect(service.grantCredits(input)).resolves.toMatchObject({
      replayed: true,
    });
    await expect(service.grantCredits({ ...input, amount: creditAmount("2") })).rejects.toThrow(
      CreditDuplicateConflictProblem,
    );
  });
});
