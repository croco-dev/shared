import { ProblemFactory } from "@croco/problems-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  creditAmount,
  CreditEventPublicationProblem,
  CreditLedgerService,
  InMemoryCreditLedgerStore,
  InvalidCreditCommandProblem,
} from "../index";

function deferred() {
  let resolve: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve: () => resolve() };
}

describe("credit event dispatch claims", () => {
  afterEach(() => vi.restoreAllMocks());

  async function seed(count = 1) {
    const store = new InMemoryCreditLedgerStore();
    const producer = new CreditLedgerService({ store, eventDelivery: "development" });
    const reference = { type: "test", id: "claims" };
    const { account } = await producer.openAccount({
      tenantId: "claims",
      idempotencyKey: "open",
      reference,
    });
    for (let index = 0; index < count; index++) {
      await producer.grantCredits({
        accountId: account.id,
        amount: creditAmount("1"),
        idempotencyKey: `grant-${index}`,
        reference,
      });
    }
    return { store, account, reference };
  }

  it("distributes bounded batches exclusively across workers", async () => {
    const { store } = await seed(5);
    const batches = await Promise.all(
      Array.from({ length: 3 }, () => store.claimPendingEventIntents(2)),
    );
    expect(batches.map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(new Set(batches.flat().map((intent) => intent.eventId)).size).toBe(5);
  });

  it("reclaims expired work and fences stale completion and release", async () => {
    const { store } = await seed();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const [first] = await store.claimPendingEventIntents(1, 100);
    expect(first).toBeDefined();
    if (!first)
      throw ProblemFactory.internalServerError("test/missing-fixture", "missing first claim");
    clock.mockReturnValue(1099);
    expect(await store.claimPendingEventIntents()).toEqual([]);
    clock.mockReturnValue(1100);
    expect(await store.markEventIntentPublished(first.eventId, first.claimToken)).toBe(false);
    const [replacement] = await store.claimPendingEventIntents(1, 100);
    if (!replacement)
      throw ProblemFactory.internalServerError("test/missing-fixture", "missing replacement claim");
    expect(replacement.claimToken).not.toBe(first.claimToken);
    expect(await store.releaseEventIntentClaim(first.eventId, first.claimToken)).toBe(false);
    expect(await store.markEventIntentPublished(first.eventId, first.claimToken)).toBe(false);
    expect(await store.claimPendingEventIntents()).toEqual([]);
    expect(await store.markEventIntentPublished(replacement.eventId, replacement.claimToken)).toBe(
      true,
    );
    expect(await store.listPendingEventIntents()).toEqual([]);
  });

  it("releases failed publications while settling every other claimed event", async () => {
    const { store } = await seed(3);
    const dispatched: string[] = [];
    const service = new CreditLedgerService({
      store,
      eventDelivery: "development",
      eventPublisher: {
        onAfterCommit() {},
        async publishIdempotently(event) {
          dispatched.push(event.eventId);
          if (dispatched.length === 1)
            throw ProblemFactory.internalServerError("test/transport-failure", "transport failure");
        },
      },
    });
    await expect(service.publishPendingEvents()).rejects.toThrow(CreditEventPublicationProblem);
    expect(dispatched).toHaveLength(3);
    expect(await store.listPendingEventIntents()).toHaveLength(1);
    await expect(service.publishPendingEvents()).resolves.toBe(1);
    expect(await store.listPendingEventIntents()).toEqual([]);
  });

  it("preserves publication and claim-release failures together", async () => {
    const { store } = await seed();
    const publicationFailure = ProblemFactory.internalServerError(
      "test/transport-failure",
      "transport failed",
    );
    const releaseFailure = new InvalidCreditCommandProblem("release failed");
    vi.spyOn(store, "releaseEventIntentClaim").mockRejectedValue(releaseFailure);
    const service = new CreditLedgerService({
      store,
      eventDelivery: "development",
      eventPublisher: {
        onAfterCommit() {},
        async publishIdempotently() {
          throw publicationFailure;
        },
      },
    });
    const failure = await service.publishPendingEvents().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CreditEventPublicationProblem);
    expect(failure).toMatchObject({
      cause: { name: "CreditEventDeliveryFailure", errors: [publicationFailure, releaseFailure] },
    });
    expect(await store.listPendingEventIntents()).toHaveLength(1);
  });

  it("claims at callback execution and excludes replay hooks racing with polling", async () => {
    const { store, account, reference } = await seed(0);
    const callbacks: Array<() => Promise<void>> = [];
    const dispatched: string[] = [];
    const service = new CreditLedgerService({
      store,
      eventDelivery: "development",
      eventPublisher: {
        onAfterCommit(publish) {
          callbacks.push(publish);
        },
        async publishIdempotently(event) {
          dispatched.push(event.eventId);
        },
      },
    });
    const input = {
      accountId: account.id,
      amount: creditAmount("1"),
      idempotencyKey: "grant",
      reference,
    };
    await service.grantCredits(input);
    await service.grantCredits(input);
    expect(dispatched).toEqual([]);
    expect(callbacks).toHaveLength(2);
    await Promise.all([service.publishPendingEvents(), ...callbacks.map((publish) => publish())]);
    expect(dispatched).toHaveLength(1);
    expect(await store.listPendingEventIntents()).toEqual([]);
  });

  it("reports lost ownership after a slow publisher without releasing its replacement", async () => {
    const { store } = await seed();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const started = deferred();
    const finish = deferred();
    const service = new CreditLedgerService({
      store,
      eventDelivery: "development",
      eventClaimLeaseMs: 100,
      eventPublisher: {
        onAfterCommit() {},
        async publishIdempotently() {
          started.resolve();
          await finish.promise;
        },
      },
    });
    const result = service.publishPendingEvents();
    const failure = expect(result).rejects.toThrow(CreditEventPublicationProblem);
    await started.promise;
    clock.mockReturnValue(1100);
    const [replacement] = await store.claimPendingEventIntents(1, 100);
    if (!replacement)
      throw ProblemFactory.internalServerError("test/missing-fixture", "missing replacement claim");
    finish.resolve();
    await failure;
    expect(await store.claimPendingEventIntents()).toEqual([]);
    expect(await store.markEventIntentPublished(replacement.eventId, replacement.claimToken)).toBe(
      true,
    );
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "rejects invalid lease %s",
    async (leaseMs) => {
      const { store } = await seed();
      await expect(store.claimPendingEventIntents(1, leaseMs)).rejects.toThrow(
        InvalidCreditCommandProblem,
      );
      expect(
        () =>
          new CreditLedgerService({
            store,
            eventDelivery: "development",
            eventClaimLeaseMs: leaseMs,
          }),
      ).toThrow(InvalidCreditCommandProblem);
    },
  );

  it.each([0, -1, 1.5, 1001, Number.NaN])("rejects invalid batch limit %s", async (limit) => {
    const { store } = await seed();
    await expect(store.claimPendingEventIntents(limit)).rejects.toThrow(
      InvalidCreditCommandProblem,
    );
  });

  it("excludes a second worker while the first worker is publishing", async () => {
    const store = new InMemoryCreditLedgerStore();
    const producer = new CreditLedgerService({ store, eventDelivery: "development" });
    const reference = { type: "test", id: "claim" };
    const { account } = await producer.openAccount({
      tenantId: "claims",
      idempotencyKey: "open",
      reference,
    });
    await producer.grantCredits({
      accountId: account.id,
      amount: creditAmount("1"),
      idempotencyKey: "grant",
      reference,
    });
    const started = deferred();
    const finish = deferred();
    const dispatched: string[] = [];
    const eventPublisher = {
      onAfterCommit() {},
      async publishIdempotently(event: { eventId: string }) {
        dispatched.push(event.eventId);
        started.resolve();
        await finish.promise;
      },
    };
    const first = new CreditLedgerService({ store, eventDelivery: "development", eventPublisher });
    const second = new CreditLedgerService({ store, eventDelivery: "development", eventPublisher });
    const firstRun = first.publishPendingEvents();
    await started.promise;
    const secondRun = second.publishPendingEvents();
    await new Promise<void>((resolve) => setImmediate(resolve));
    finish.resolve();
    const counts = await Promise.all([firstRun, secondRun]);
    expect(dispatched).toHaveLength(1);
    expect(counts).toEqual([1, 0]);
  });
});
