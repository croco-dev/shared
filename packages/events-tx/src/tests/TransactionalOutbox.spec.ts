import {
  DefaultEventSerializer,
  DomainEvent,
  type EventBus,
  EventRegistry,
  type EventSubscription,
} from "@croco/events-core";
import {
  createIdempotencyCoordinator,
  deriveIdempotencyKey,
  type IdempotencyFailedRecord,
  type IdempotencyFailOptions,
  InMemoryIdempotencyStore,
  InvalidIdempotencyKeyProblem,
} from "@croco/idempotency-core";
import { ProblemCategory } from "@croco/problems-core";
import * as telemetry from "@croco/telemetry-api";
import { TxManager } from "@croco/tx-core";
import { drizzle as createPgProxyDrizzle } from "drizzle-orm/pg-proxy";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEventBusOutboxPublisher,
  DrizzleTransactionalEventStore,
  InboxClaimConflictProblem,
  InMemoryTransactionalEventStore,
  normalizeTransactionalEventError,
  OutboxPublishExhaustedProblem,
  OutboxStorageProblem,
  OutboxTransactionRequiredProblem,
  TransactionalInboxConsumer,
  TransactionalOutbox,
  TransactionalOutboxRelay,
  type TransactionalOutboxMessage,
} from "../index";
import type { DrizzleTransactionalEventStoreDb } from "../index";

class AccountCreditedEvent extends DomainEvent {
  static eventName = "account.credited";

  constructor(
    readonly accountId: string,
    readonly amount: number,
  ) {
    super();
  }

  static fromPayload(payload: Record<string, unknown>): AccountCreditedEvent {
    return new AccountCreditedEvent(String(payload.accountId), Number(payload.amount));
  }
}

function createClock(initial: Date): { now: () => Date; advance: (ms: number) => Date } {
  let current = new Date(initial.getTime());
  return {
    now: () => new Date(current.getTime()),
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
      return new Date(current.getTime());
    },
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function createOutboxFixture() {
  const store = new InMemoryTransactionalEventStore();
  const txManager = new TxManager(store.createTxAdapter());
  const clock = createClock(new Date("2026-01-01T00:00:00.000Z"));
  let idCounter = 0;
  const outbox = new TransactionalOutbox({
    store,
    txManager,
    now: clock.now,
    idFactory: () => `message-${++idCounter}`,
  });

  return {
    store,
    txManager,
    clock,
    outbox,
  };
}

async function appendMessage(
  fixture: ReturnType<typeof createOutboxFixture>,
  options: { idempotencyKey?: string; maxAttempts?: number } = {},
): Promise<TransactionalOutboxMessage> {
  return fixture.txManager.run(() =>
    fixture.outbox.append(new AccountCreditedEvent("acct-1", 100), {
      aggregateId: "acct-1",
      idempotencyKey: options.idempotencyKey ?? "credit-acct-1",
      maxAttempts: options.maxAttempts,
    }),
  );
}

class ObservedIdempotencyStore<TResult> extends InMemoryIdempotencyStore<TResult> {
  readonly failures: IdempotencyFailOptions[] = [];

  override async fail(options: IdempotencyFailOptions): Promise<IdempotencyFailedRecord> {
    this.failures.push(options);
    return super.fail(options);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("transactional event spine smoke", () => {
  it("proves commit dispatch, rollback isolation, retry evidence, and idempotency behavior", async () => {
    const recordEventSpy = vi.spyOn(telemetry, "recordEvent").mockImplementation(() => {});
    const recordErrorSpy = vi.spyOn(telemetry, "recordError").mockImplementation(() => {});
    const fixture = createOutboxFixture();
    const publishedEvents: DomainEvent[] = [];
    const eventBusSubscriptions: EventSubscription[] = [];
    const projectedMessageIds: string[] = [];
    const inboxConsumer = new TransactionalInboxConsumer({
      store: fixture.store,
      consumerId: "ledger-projection",
      now: fixture.clock.now,
    });
    const eventBus: EventBus = {
      publish: async (event) => {
        publishedEvents.push(event);
        for (const subscription of eventBusSubscriptions) {
          if (subscription.eventName === event.eventName) {
            await subscription.handler?.handle(event);
          }
        }
      },
      subscribe: (subscription) => {
        eventBusSubscriptions.push(subscription);
      },
      unsubscribe: (subscription) => {
        const index = eventBusSubscriptions.indexOf(subscription);
        if (index >= 0) {
          eventBusSubscriptions.splice(index, 1);
        }
      },
      clear: () => {
        publishedEvents.length = 0;
        eventBusSubscriptions.length = 0;
      },
    };
    const serializer = new DefaultEventSerializer(
      new EventRegistry().register(AccountCreditedEvent),
    );
    const publishToEventBus = createEventBusOutboxPublisher(eventBus, serializer);
    const relay = new TransactionalOutboxRelay({
      store: fixture.store,
      publish: publishToEventBus,
      now: fixture.clock.now,
      retry: {
        baseDelayMs: 1_000,
      },
    });
    eventBus.subscribe({
      eventName: AccountCreditedEvent.eventName,
      handlerClass: class LedgerProjectionHandler {
        handle(): void {}
      },
      handler: {
        handle: async (event) => {
          const messages = await fixture.store.listOutboxMessages();
          const message = messages.find((candidate) => candidate.eventId === event.eventId);
          if (message) {
            await inboxConsumer.handle(message, async (handledMessage) => {
              projectedMessageIds.push(handledMessage.id);
            });
          }
        },
      },
    });
    const commandStore = new InMemoryIdempotencyStore<{ messageId: string }>();
    const commandCoordinator = createIdempotencyCoordinator({
      store: commandStore,
    });
    const commandKey = deriveIdempotencyKey({
      namespace: "transactional-events",
      tenantId: "tenant-a",
      source: {
        kind: "explicit",
        key: "credit-acct-1",
        fingerprint: "acct-1:100",
      },
    });

    expect(commandKey.telemetryAttributes).toMatchObject({
      "croco.idempotency.key": "credit-acct-1",
      "croco.idempotency.namespace": "transactional-events",
      "croco.idempotency.scope": "tenant",
      "croco.idempotency.tenant_id": "tenant-a",
      "croco.idempotency.source": "explicit",
      "croco.idempotency.fingerprint": "acct-1:100",
    });

    const committed = await commandCoordinator.execute(
      {
        key: commandKey,
        metadata: {
          operation: "credit-account",
        },
      },
      async () => {
        const message = await fixture.txManager.run(() =>
          fixture.outbox.append(new AccountCreditedEvent("acct-1", 100), {
            aggregateId: "acct-1",
            idempotencyKey: commandKey.storageKey,
            metadata: commandKey.telemetryAttributes,
          }),
        );

        return {
          messageId: message.id,
        };
      },
    );

    expect(committed).toMatchObject({
      outcome: "executed",
      response: {
        messageId: "message-1",
      },
    });

    await expect(
      relay.publishBatch({ limit: 10, now: fixture.clock.now() }),
    ).resolves.toMatchObject({
      claimed: 1,
      published: 1,
    });
    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0]).toBeInstanceOf(AccountCreditedEvent);
    expect(recordEventSpy).toHaveBeenCalledWith("events-tx.outbox.appended", {
      "events-tx.message_id": "message-1",
      "events-tx.event_type": AccountCreditedEvent.eventName,
    });
    expect(recordEventSpy).toHaveBeenCalledWith("events-tx.outbox.published", {
      "events-tx.message_id": "message-1",
      "events-tx.event_type": AccountCreditedEvent.eventName,
    });

    const [publishedMessage] = await fixture.store.listOutboxMessages({ status: "published" });
    expect(publishedMessage).toMatchObject({
      id: "message-1",
      idempotencyKey: commandKey.storageKey,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "events-tx/outbox-appended",
        }),
        expect.objectContaining({
          code: "events-tx/outbox-published",
        }),
      ]),
    });

    const [processedRecord] = await fixture.store.listInboxRecords({
      consumerId: "ledger-projection",
    });
    const duplicate = await inboxConsumer.handle(publishedMessage, async () => {
      projectedMessageIds.push("duplicate-side-effect");
    });

    expect(processedRecord).toMatchObject({
      status: "processed",
      attempts: 1,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "events-tx/inbox-processed",
        }),
      ]),
    });
    expect(duplicate.status).toBe("duplicate");
    expect(projectedMessageIds).toEqual(["message-1"]);

    const replayed = await commandCoordinator.execute({ key: commandKey }, async () => {
      const message = await fixture.txManager.run(() =>
        fixture.outbox.append(new AccountCreditedEvent("acct-1", 100), {
          aggregateId: "acct-1",
          idempotencyKey: commandKey.storageKey,
        }),
      );

      return {
        messageId: message.id,
      };
    });

    expect(replayed).toMatchObject({
      outcome: "replayed",
      response: {
        messageId: "message-1",
      },
    });
    await expect(fixture.store.listOutboxMessages()).resolves.toHaveLength(1);
    await expect(
      relay.publishBatch({ limit: 10, now: fixture.clock.now() }),
    ).resolves.toMatchObject({
      claimed: 0,
    });
    expect(publishedEvents).toHaveLength(1);

    await expect(
      fixture.txManager.run(async () => {
        await fixture.outbox.append(new AccountCreditedEvent("acct-rollback", 50), {
          aggregateId: "acct-rollback",
          idempotencyKey: "rollback-credit",
        });
        throw new Error("business rollback");
      }),
    ).rejects.toThrow("business rollback");
    await expect(fixture.store.findOutboxByIdempotencyKey("rollback-credit")).resolves.toBeNull();
    await expect(
      relay.publishBatch({ limit: 10, now: fixture.clock.now() }),
    ).resolves.toMatchObject({
      claimed: 0,
    });
    expect(publishedEvents).toHaveLength(1);

    const retryMessage = await fixture.txManager.run(() =>
      fixture.outbox.append(new AccountCreditedEvent("acct-retry", 75), {
        aggregateId: "acct-retry",
        idempotencyKey: "relay-retry-credit",
        maxAttempts: 2,
      }),
    );
    let relayAttempts = 0;
    const retryRelay = new TransactionalOutboxRelay({
      store: fixture.store,
      now: fixture.clock.now,
      retry: {
        baseDelayMs: 1_000,
      },
      publish: async (message) => {
        relayAttempts += 1;
        if (relayAttempts === 1) {
          throw new Error("broker unavailable");
        }
        await publishToEventBus(message);
      },
    });

    await expect(
      retryRelay.publishBatch({ limit: 10, now: fixture.clock.now() }),
    ).resolves.toMatchObject({
      claimed: 1,
      scheduledRetry: 1,
    });
    expect(publishedEvents).toHaveLength(1);
    expect(recordErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: "broker unavailable" }),
    );
    await expect(fixture.store.findOutboxById(retryMessage.id)).resolves.toMatchObject({
      status: "retrying",
      lastError: {
        message: "broker unavailable",
      },
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "events-tx/outbox-publish-failed",
        }),
      ]),
    });

    fixture.clock.advance(1_000);
    await expect(
      retryRelay.publishBatch({ limit: 10, now: fixture.clock.now() }),
    ).resolves.toMatchObject({
      claimed: 1,
      published: 1,
    });
    expect(relayAttempts).toBe(2);
    expect(publishedEvents).toHaveLength(2);

    const poisonMessage = await fixture.txManager.run(() =>
      fixture.outbox.append(new AccountCreditedEvent("acct-poison", 25), {
        aggregateId: "acct-poison",
        idempotencyKey: "relay-poison-credit",
        maxAttempts: 1,
      }),
    );
    const poisonRelay = new TransactionalOutboxRelay({
      store: fixture.store,
      now: fixture.clock.now,
      publish: async () => {
        throw new Error("poison broker unavailable");
      },
    });
    const poisoned = await poisonRelay.publishBatch({ limit: 10, now: fixture.clock.now() });

    expect(poisoned).toMatchObject({
      claimed: 1,
      poisoned: 1,
      deadLettered: 0,
    });
    const [poisonResult] = poisoned.results;
    expect(poisonResult.status).toBe("poisoned");
    if (poisonResult.status !== "poisoned") {
      throw new Error("Expected poisoned relay result.");
    }
    expect(poisonResult.problem).toBeInstanceOf(OutboxPublishExhaustedProblem);
    expect(poisonResult.problem.toJSON()).toMatchObject({
      code: "events-tx/outbox-publish-exhausted",
      status: 500,
      detail: `Outbox message '${poisonMessage.id}' exhausted 1 publish attempt(s).`,
    });
    expect(recordErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: "poison broker unavailable" }),
    );
    await expect(fixture.store.findOutboxById(poisonMessage.id)).resolves.toMatchObject({
      status: "poisoned",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "events-tx/outbox-publish-failed",
        }),
        expect.objectContaining({
          code: "events-tx/outbox-poisoned",
        }),
      ]),
    });

    const inboxRetryMessage = await appendMessage(fixture, {
      idempotencyKey: "inbox-retry-credit",
    });
    const inboxSideEffects: string[] = [];
    const retryingConsumer = new TransactionalInboxConsumer({
      store: fixture.store,
      consumerId: "risk-projection",
      now: fixture.clock.now,
      throwOnError: false,
    });
    const failedInbox = await retryingConsumer.handle(inboxRetryMessage, async () => {
      throw new Error("projection offline");
    });
    const retriedInbox = await retryingConsumer.handle(inboxRetryMessage, async (message) => {
      inboxSideEffects.push(message.id);
    });

    expect(failedInbox).toMatchObject({
      status: "failed",
      record: {
        attempts: 1,
        failureReason: "projection offline",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: "events-tx/inbox-failed",
          }),
        ]),
      },
    });
    expect(retriedInbox).toMatchObject({
      status: "processed",
      record: {
        attempts: 2,
      },
    });
    expect(inboxSideEffects).toEqual([inboxRetryMessage.id]);

    const failureStore = new ObservedIdempotencyStore<string>();
    const failureCoordinator = createIdempotencyCoordinator({
      store: failureStore,
    });
    const failureKey = deriveIdempotencyKey({
      namespace: "transactional-events",
      tenantId: "tenant-a",
      source: {
        kind: "explicit",
        key: "failure-credit",
        fingerprint: "invalid-amount",
      },
    });

    await expect(
      failureCoordinator.execute({ key: failureKey }, () => {
        throw new InvalidIdempotencyKeyProblem("amount must be positive", {
          ...failureKey.telemetryAttributes,
        });
      }),
    ).rejects.toBeInstanceOf(InvalidIdempotencyKeyProblem);
    expect(failureStore.failures).toHaveLength(1);
    expect(failureStore.failures[0]).toMatchObject({
      retryable: false,
      problem: {
        code: "idempotency-core/invalid-key",
        status: 400,
        detail: "Invalid idempotency key: amount must be positive",
      },
    });
    expect(failureKey.telemetryAttributes).toMatchObject({
      "croco.idempotency.source": "explicit",
      "croco.idempotency.fingerprint": "invalid-amount",
    });

    const duplicateHandler = vi.fn(() => "must-not-run");
    await expect(
      failureCoordinator.execute({ key: failureKey }, duplicateHandler),
    ).resolves.toMatchObject({
      outcome: "failed",
      record: { problem: failureStore.failures[0].problem },
    });
    expect(duplicateHandler).not.toHaveBeenCalled();
  });
});

describe("TransactionalOutbox", () => {
  it("requires an active tx-core transaction and rolls back appended messages with the transaction", async () => {
    const fixture = createOutboxFixture();

    await expect(
      fixture.outbox.append(new AccountCreditedEvent("acct-1", 100)),
    ).rejects.toBeInstanceOf(OutboxTransactionRequiredProblem);

    await expect(
      fixture.txManager.run(async () => {
        await fixture.outbox.append(new AccountCreditedEvent("acct-1", 100), {
          aggregateId: "acct-1",
          idempotencyKey: "credit-acct-1",
        });
        throw new Error("business write failed");
      }),
    ).rejects.toThrow("business write failed");

    await expect(fixture.store.listOutboxMessages()).resolves.toHaveLength(0);
  });

  it("rejects append when tx-core reports a transaction without a client", async () => {
    const store = new InMemoryTransactionalEventStore();
    const outbox = new TransactionalOutbox({
      store,
      txManager: {
        isInTransaction: () => true,
        getClient: () => undefined,
      },
    });

    await expect(outbox.append(new AccountCreditedEvent("acct-1", 100))).rejects.toBeInstanceOf(
      OutboxTransactionRequiredProblem,
    );
  });

  it("appends only one outbox message for the same idempotency key in a transaction", async () => {
    const fixture = createOutboxFixture();
    const event = new AccountCreditedEvent("acct-1", 100);

    const [first, second] = await fixture.txManager.run(async () => {
      const appended = await fixture.outbox.append(event, {
        aggregateId: "acct-1",
        idempotencyKey: "credit-acct-1",
      });
      const duplicate = await fixture.outbox.append(event, {
        aggregateId: "acct-1",
        idempotencyKey: "credit-acct-1",
      });
      return [appended, duplicate] as const;
    });

    expect(second.id).toBe(first.id);
    const messages = await fixture.store.listOutboxMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].aggregateId).toBe("acct-1");
    expect(messages[0].payload).toEqual({ accountId: "acct-1", amount: 100 });
  });

  it("replays the same event after attempt-specific defaults advance", async () => {
    const fixture = createOutboxFixture();
    const event = new AccountCreditedEvent("acct-1", 100);

    const first = await fixture.txManager.run(() =>
      fixture.outbox.append(event, {
        aggregateId: "acct-1",
        idempotencyKey: "credit-acct-1",
      }),
    );
    fixture.clock.advance(1_000);
    const replay = await fixture.txManager.run(() =>
      fixture.outbox.append(event, {
        aggregateId: "acct-1",
        idempotencyKey: "credit-acct-1",
        maxAttempts: 9,
      }),
    );

    expect(replay.id).toBe(first.id);
    await expect(fixture.store.listOutboxMessages()).resolves.toHaveLength(1);
  });
});

describe("TransactionalOutboxRelay", () => {
  it("cancels an active batch and releases every unstarted claim for retry", async () => {
    const fixture = createOutboxFixture();
    await appendMessage(fixture, { idempotencyKey: "credit-acct-1" });
    await appendMessage(fixture, { idempotencyKey: "credit-acct-2" });
    const publishStarted = createDeferred<void>();
    const publish = vi.fn(
      async (_message: TransactionalOutboxMessage, signal?: AbortSignal): Promise<void> => {
        publishStarted.resolve(undefined);
        await new Promise<void>((_resolve, reject) => {
          const rejectWithAbort = () => reject(signal?.reason);
          if (signal?.aborted) {
            rejectWithAbort();
            return;
          }
          signal?.addEventListener("abort", rejectWithAbort, { once: true });
        });
      },
    );
    const relay = new TransactionalOutboxRelay({
      store: fixture.store,
      publish,
      now: fixture.clock.now,
      retry: { baseDelayMs: 0 },
    });

    const batch = relay.publishBatch({ limit: 2, now: fixture.clock.now() });
    await publishStarted.promise;

    await expect(relay.drain()).resolves.toEqual({
      status: "drained",
      activeBatches: 1,
      pendingBatches: 0,
    });
    await expect(batch).resolves.toMatchObject({
      status: "cancelled",
      claimed: 2,
      scheduledRetry: 1,
      released: 1,
      results: [
        { status: "scheduled_retry" },
        { status: "released", message: { attempts: 0, status: "retrying" } },
      ],
    });
    expect(publish).toHaveBeenCalledTimes(1);
    await expect(fixture.store.listOutboxMessages()).resolves.toMatchObject([
      { attempts: 1, status: "retrying" },
      {
        attempts: 0,
        status: "retrying",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "events-tx/outbox-claim-released" }),
        ]),
      },
    ]);
  });

  it("returns a bounded drain outcome when an active publisher ignores cancellation", async () => {
    const fixture = createOutboxFixture();
    await appendMessage(fixture);
    const publishStarted = createDeferred<void>();
    const publishCompletion = createDeferred<void>();
    const relay = new TransactionalOutboxRelay({
      store: fixture.store,
      publish: async () => {
        publishStarted.resolve(undefined);
        await publishCompletion.promise;
      },
      now: fixture.clock.now,
    });
    const batch = relay.publishBatch({ limit: 1, now: fixture.clock.now() });
    await publishStarted.promise;
    const boundary = new AbortController();
    const drain = relay.drain(boundary.signal);

    boundary.abort(new Error("shutdown deadline exceeded"));

    await expect(drain).resolves.toEqual({
      status: "cancelled",
      activeBatches: 1,
      pendingBatches: 1,
    });
    publishCompletion.resolve(undefined);
    await expect(batch).resolves.toMatchObject({
      status: "cancelled",
      claimed: 1,
      published: 1,
      released: 0,
    });
  });

  it("does not claim more work after the relay has stopped", async () => {
    const fixture = createOutboxFixture();
    await appendMessage(fixture);
    const relay = new TransactionalOutboxRelay({
      store: fixture.store,
      publish: vi.fn(async () => {}),
      now: fixture.clock.now,
    });

    relay.stop();

    await expect(relay.publishBatch({ limit: 1, now: fixture.clock.now() })).resolves.toEqual({
      status: "stopped",
      claimed: 0,
      published: 0,
      scheduledRetry: 0,
      poisoned: 0,
      deadLettered: 0,
      staleClaimed: 0,
      released: 0,
      results: [],
    });
    await expect(fixture.store.listOutboxMessages()).resolves.toMatchObject([
      { attempts: 0, status: "pending" },
    ]);
  });

  it("does not claim work for an already-cancelled batch signal", async () => {
    const fixture = createOutboxFixture();
    await appendMessage(fixture);
    const publish = vi.fn(async () => {});
    const relay = new TransactionalOutboxRelay({
      store: fixture.store,
      publish,
      now: fixture.clock.now,
    });
    const cancellation = new AbortController();
    cancellation.abort(new Error("host is shutting down"));

    await expect(
      relay.publishBatch({ limit: 1, now: fixture.clock.now(), signal: cancellation.signal }),
    ).resolves.toMatchObject({
      status: "cancelled",
      claimed: 0,
      released: 0,
    });
    expect(publish).not.toHaveBeenCalled();
    await expect(fixture.store.listOutboxMessages()).resolves.toMatchObject([
      { attempts: 0, status: "pending" },
    ]);
  });

  it("keeps exhausted messages poisoned when no dead-letter hook is configured and emits telemetry", async () => {
    const recordEventSpy = vi.spyOn(telemetry, "recordEvent").mockImplementation(() => {});
    const recordErrorSpy = vi.spyOn(telemetry, "recordError").mockImplementation(() => {});
    const fixture = createOutboxFixture();
    const poisonMessage = await appendMessage(fixture, { maxAttempts: 1 });
    const relay = new TransactionalOutboxRelay({
      store: fixture.store,
      publish: async () => {
        throw new Error("broker unavailable");
      },
      now: fixture.clock.now,
    });

    const result = await relay.publishBatch({ limit: 1, now: fixture.clock.now() });

    expect(result).toMatchObject({
      status: "failed",
      claimed: 1,
      poisoned: 1,
      deadLettered: 0,
    });
    expect(result.results[0].status).toBe("poisoned");
    expect(recordEventSpy).toHaveBeenCalledWith("events-tx.outbox.poisoned", {
      "events-tx.message_id": poisonMessage.id,
      "events-tx.event_type": poisonMessage.eventType,
      "events-tx.attempts": 1,
      "events-tx.error": "broker unavailable",
      "events-tx.problem": "events-tx/outbox-publish-exhausted",
    });
    expect(recordErrorSpy).toHaveBeenCalledWith(expect.any(OutboxPublishExhaustedProblem));
    expect((await fixture.store.listOutboxMessages())[0]).toMatchObject({
      status: "poisoned",
      deadLetterReason: "broker unavailable",
    });
  });

  it("isolates dead-letter hook exceptions and continues processing remaining batch messages", async () => {
    const recordEventSpy = vi.spyOn(telemetry, "recordEvent").mockImplementation(() => {});
    const recordErrorSpy = vi.spyOn(telemetry, "recordError").mockImplementation(() => {});
    const fixture = createOutboxFixture();
    const poisonMsg = await appendMessage(fixture, { idempotencyKey: "poison-1", maxAttempts: 1 });
    const successMsg = await appendMessage(fixture, {
      idempotencyKey: "success-2",
      maxAttempts: 1,
    });
    const published: string[] = [];

    const relay = new TransactionalOutboxRelay({
      store: fixture.store,
      publish: async (message) => {
        if (message.id === poisonMsg.id) {
          throw new Error("broker down for poison");
        }
        published.push(message.id);
      },
      deadLetter: async () => {
        throw new Error("dlq sink unreachable");
      },
      now: fixture.clock.now,
    });

    const result = await relay.publishBatch({ limit: 2, now: fixture.clock.now() });

    expect(result).toMatchObject({
      status: "degraded",
      claimed: 2,
      published: 1,
      poisoned: 1,
      deadLettered: 0,
    });
    expect(published).toEqual([successMsg.id]);
    expect(result.results[0]).toMatchObject({
      status: "poisoned",
      message: expect.objectContaining({ id: poisonMsg.id, status: "poisoned" }),
      problem: expect.any(OutboxPublishExhaustedProblem),
      deadLetterError: expect.objectContaining({ message: "dlq sink unreachable" }),
    });
    expect(result.results[1]).toMatchObject({
      status: "published",
      message: expect.objectContaining({ id: successMsg.id, status: "published" }),
    });
    expect(recordEventSpy).toHaveBeenCalledWith("events-tx.outbox.poisoned", {
      "events-tx.message_id": poisonMsg.id,
      "events-tx.event_type": poisonMsg.eventType,
      "events-tx.attempts": 1,
      "events-tx.error": "broker down for poison",
      "events-tx.problem": "events-tx/outbox-publish-exhausted",
      "events-tx.dead_letter_error": "dlq sink unreachable",
    });
    expect(recordErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: "dlq sink unreachable" }),
    );
    expect(recordErrorSpy).toHaveBeenCalledWith(expect.any(OutboxPublishExhaustedProblem));
  });

  it("returns degraded status when a batch contains both poisoned and dead-lettered messages", async () => {
    const fixture = createOutboxFixture();
    const deadLetterMsg = await appendMessage(fixture, { idempotencyKey: "dlq-1", maxAttempts: 1 });
    const poisonMsg = await appendMessage(fixture, { idempotencyKey: "poison-2", maxAttempts: 1 });

    const relay = new TransactionalOutboxRelay({
      store: fixture.store,
      publish: async () => {
        throw new Error("publish failed");
      },
      deadLetter: async (message) => {
        if (message.id === poisonMsg.id) {
          throw new Error("dlq write failed");
        }
      },
      now: fixture.clock.now,
    });

    const result = await relay.publishBatch({ limit: 2, now: fixture.clock.now() });

    expect(result).toMatchObject({
      status: "degraded",
      claimed: 2,
      published: 0,
      scheduledRetry: 0,
      poisoned: 1,
      deadLettered: 1,
    });
    expect(result.results[0]).toMatchObject({
      status: "dead_lettered",
      message: expect.objectContaining({ id: deadLetterMsg.id, status: "dead_lettered" }),
    });
    expect(result.results[1]).toMatchObject({
      status: "poisoned",
      message: expect.objectContaining({ id: poisonMsg.id, status: "poisoned" }),
      deadLetterError: expect.objectContaining({ message: "dlq write failed" }),
    });
  });

  it("reschedules failed publishes, then moves exhausted messages through the dead-letter hook", async () => {
    const recordEventSpy = vi.spyOn(telemetry, "recordEvent").mockImplementation(() => {});
    const fixture = createOutboxFixture();
    await appendMessage(fixture, { maxAttempts: 2 });
    const publish = vi.fn(async () => {
      throw new Error("broker unavailable");
    });
    const deadLetter = vi.fn(async () => {});
    const relay = new TransactionalOutboxRelay({
      store: fixture.store,
      publish,
      deadLetter,
      now: fixture.clock.now,
      retry: {
        baseDelayMs: 1_000,
      },
    });

    const first = await relay.publishBatch({ limit: 1, now: fixture.clock.now() });
    expect(first.scheduledRetry).toBe(1);
    expect(first.deadLettered).toBe(0);
    expect((await fixture.store.listOutboxMessages())[0].status).toBe("retrying");

    const immediate = await relay.publishBatch({ limit: 1, now: fixture.clock.now() });
    expect(immediate.claimed).toBe(0);

    fixture.clock.advance(1_000);
    const exhausted = await relay.publishBatch({ limit: 1, now: fixture.clock.now() });
    expect(exhausted.deadLettered).toBe(1);
    expect(deadLetter).toHaveBeenCalledTimes(1);
    expect(recordEventSpy).toHaveBeenCalledWith("events-tx.outbox.dead_lettered", {
      "events-tx.message_id": expect.any(String),
      "events-tx.event_type": expect.any(String),
      "events-tx.attempts": 2,
    });
    expect((await fixture.store.listOutboxMessages())[0].status).toBe("dead_lettered");
  });

  it("reclaims a publishing message after visibility timeout to support relay crash restart", async () => {
    const fixture = createOutboxFixture();
    await appendMessage(fixture);
    const claimed = await fixture.store.claimOutboxBatch({
      limit: 1,
      now: fixture.clock.now(),
      visibilityTimeoutMs: 1_000,
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0].status).toBe("publishing");

    const published: string[] = [];
    const relay = new TransactionalOutboxRelay({
      store: fixture.store,
      publish: async (message) => {
        published.push(message.id);
      },
      now: fixture.clock.now,
    });

    fixture.clock.advance(999);
    expect(await relay.publishBatch({ limit: 1, now: fixture.clock.now() })).toMatchObject({
      claimed: 0,
    });

    fixture.clock.advance(1);
    expect(await relay.publishBatch({ limit: 1, now: fixture.clock.now() })).toMatchObject({
      published: 1,
    });
    expect(published).toEqual([claimed[0].id]);
    expect((await fixture.store.listOutboxMessages())[0].status).toBe("published");
  });

  it("ignores stale completion from an expired claim after another relay wins", async () => {
    const fixture = createOutboxFixture();
    await appendMessage(fixture);
    const [firstClaim] = await fixture.store.claimOutboxBatch({
      limit: 1,
      now: fixture.clock.now(),
      visibilityTimeoutMs: 1_000,
    });

    fixture.clock.advance(1_000);
    const [secondClaim] = await fixture.store.claimOutboxBatch({
      limit: 1,
      now: fixture.clock.now(),
      visibilityTimeoutMs: 1_000,
    });
    await expect(
      fixture.store.markOutboxPublished({
        id: secondClaim.id,
        expectedAttempts: secondClaim.attempts,
        now: fixture.clock.now(),
      }),
    ).resolves.toMatchObject({
      status: "published",
      attempts: 2,
    });

    await expect(
      fixture.store.markOutboxPublished({
        id: firstClaim.id,
        expectedAttempts: firstClaim.attempts,
        now: fixture.clock.now(),
      }),
    ).resolves.toBeNull();
    await expect(
      fixture.store.markOutboxFailed({
        id: firstClaim.id,
        expectedAttempts: firstClaim.attempts,
        now: fixture.clock.now(),
        nextVisibleAt: fixture.clock.now(),
        error: {
          name: "Error",
          message: "stale relay failure",
        },
        diagnostic: {
          code: "events-tx/test-stale",
          message: "stale relay failure",
          at: fixture.clock.now(),
        },
      }),
    ).resolves.toBeNull();
    await expect(fixture.store.listOutboxMessages()).resolves.toMatchObject([
      {
        status: "published",
        attempts: 2,
      },
    ]);
  });

  it("reports stale claims when a publish hook completed the current claim first", async () => {
    const fixture = createOutboxFixture();
    await appendMessage(fixture);
    const relay = new TransactionalOutboxRelay({
      store: fixture.store,
      publish: async (message) => {
        await fixture.store.markOutboxPublished({
          id: message.id,
          expectedAttempts: message.attempts,
          now: fixture.clock.now(),
        });
      },
      now: fixture.clock.now,
    });

    const result = await relay.publishBatch({ limit: 1, now: fixture.clock.now() });

    expect(result).toMatchObject({
      claimed: 1,
      published: 0,
      staleClaimed: 1,
    });
    expect(result.results[0].status).toBe("stale_claim");
    expect((await fixture.store.listOutboxMessages())[0].status).toBe("published");
  });

  it("reports stale claims when a publish failure is already completed by another relay", async () => {
    const fixture = createOutboxFixture();
    await appendMessage(fixture);
    const relay = new TransactionalOutboxRelay({
      store: fixture.store,
      publish: async (message) => {
        await fixture.store.markOutboxPublished({
          id: message.id,
          expectedAttempts: message.attempts,
          now: fixture.clock.now(),
        });
        throw new Error("late failure");
      },
      now: fixture.clock.now,
    });

    const result = await relay.publishBatch({ limit: 1, now: fixture.clock.now() });

    expect(result).toMatchObject({
      claimed: 1,
      staleClaimed: 1,
    });
    expect(result.results[0]).toMatchObject({
      status: "stale_claim",
      diagnostic: {
        code: "events-tx/outbox-fail-stale-claim",
      },
    });
  });

  it("reports stale claims when a dead-letter hook completes the poisoned message first", async () => {
    const fixture = createOutboxFixture();
    await appendMessage(fixture, { maxAttempts: 1 });
    const relay = new TransactionalOutboxRelay({
      store: fixture.store,
      publish: async () => {
        throw new Error("broker unavailable");
      },
      deadLetter: async (message) => {
        await fixture.store.markOutboxDeadLettered({
          id: message.id,
          expectedAttempts: message.attempts,
          now: fixture.clock.now(),
          reason: "handled elsewhere",
          diagnostic: {
            code: "events-tx/test-dead-lettered",
            message: "handled elsewhere",
            at: fixture.clock.now(),
          },
        });
      },
      now: fixture.clock.now,
    });

    const result = await relay.publishBatch({ limit: 1, now: fixture.clock.now() });

    expect(result).toMatchObject({
      claimed: 1,
      staleClaimed: 1,
    });
    expect(result.results[0]).toMatchObject({
      status: "stale_claim",
      diagnostic: {
        code: "events-tx/outbox-dead-letter-stale-claim",
      },
    });
    expect((await fixture.store.listOutboxMessages())[0].status).toBe("dead_lettered");
  });
});

describe("TransactionalInboxConsumer", () => {
  it("deduplicates processed inbox keys and retries failed inbox records explicitly", async () => {
    const fixture = createOutboxFixture();
    const message = await appendMessage(fixture);
    const processedHandler = vi.fn(async () => {});
    const consumer = new TransactionalInboxConsumer({
      store: fixture.store,
      consumerId: "ledger-projection",
      now: fixture.clock.now,
    });

    const first = await consumer.handle(message, processedHandler);
    const duplicate = await consumer.handle(message, processedHandler);

    expect(first.status).toBe("processed");
    expect(duplicate.status).toBe("duplicate");
    expect(processedHandler).toHaveBeenCalledTimes(1);

    const failingMessage = await appendMessage(fixture, {
      idempotencyKey: "credit-acct-2",
    });
    const retryingConsumer = new TransactionalInboxConsumer({
      store: fixture.store,
      consumerId: "audit-projection",
      now: fixture.clock.now,
      throwOnError: false,
    });

    const failed = await retryingConsumer.handle(failingMessage, async () => {
      throw new Error("projection offline");
    });
    const retried = await retryingConsumer.handle(failingMessage, async () => {});

    expect(failed.status).toBe("failed");
    expect(retried.status).toBe("processed");
    expect(retried.record.attempts).toBe(2);
  });

  it("persists inbox failures and rethrows by default", async () => {
    const fixture = createOutboxFixture();
    const message = await appendMessage(fixture);
    const consumer = new TransactionalInboxConsumer({
      store: fixture.store,
      consumerId: "risk-projection",
      now: fixture.clock.now,
    });

    await expect(
      consumer.handle(message, async () => {
        throw new Error("projection offline");
      }),
    ).rejects.toThrow("projection offline");

    await expect(
      fixture.store.findInboxRecord("risk-projection", message.idempotencyKey),
    ).resolves.toMatchObject({
      status: "failed",
      failureReason: "projection offline",
    });
  });

  it("preserves the handler failure when inbox failure persistence also rejects", async () => {
    const fixture = createOutboxFixture();
    const message = await appendMessage(fixture);
    const handlerError = new Error("projection offline");
    const persistenceError = new OutboxStorageProblem("failure persistence unavailable");
    vi.spyOn(fixture.store, "markInboxFailed").mockRejectedValue(persistenceError);
    const recordErrorSpy = vi.spyOn(telemetry, "recordError").mockImplementation(() => {
      throw new Error("telemetry unavailable");
    });
    const consumer = new TransactionalInboxConsumer({
      store: fixture.store,
      consumerId: "risk-projection",
      now: fixture.clock.now,
    });

    await expect(
      consumer.handle(message, async () => {
        throw handlerError;
      }),
    ).rejects.toBe(handlerError);

    expect(recordErrorSpy).toHaveBeenCalledWith(persistenceError);
    expect(Object.getOwnPropertyDescriptor(handlerError, "inboxFailurePersistenceError")).toEqual({
      configurable: true,
      enumerable: false,
      value: persistenceError,
      writable: false,
    });
    await expect(
      fixture.store.findInboxRecord("risk-projection", message.idempotencyKey),
    ).resolves.toMatchObject({
      status: "processing",
      attempts: 1,
    });
  });

  it("returns the handler failure when inbox failure persistence rejects and throwing is disabled", async () => {
    const fixture = createOutboxFixture();
    const message = await appendMessage(fixture);
    const handlerError = new Error("projection offline");
    const persistenceError = new OutboxStorageProblem("failure persistence unavailable");
    vi.spyOn(fixture.store, "markInboxFailed").mockRejectedValue(persistenceError);
    const consumer = new TransactionalInboxConsumer({
      store: fixture.store,
      consumerId: "risk-projection",
      now: fixture.clock.now,
      throwOnError: false,
    });

    const result = await consumer.handle(message, async () => {
      throw handlerError;
    });

    expect(result).toMatchObject({
      status: "failed",
      record: {
        status: "processing",
        attempts: 1,
      },
      error: {
        name: "Error",
        message: "projection offline",
      },
    });
    if (result.status !== "failed") {
      throw new Error("Expected failed inbox result.");
    }
    expect(Object.getOwnPropertyDescriptor(result.error, "inboxFailurePersistenceError")).toEqual({
      configurable: true,
      enumerable: false,
      value: persistenceError,
      writable: false,
    });
  });

  it("propagates the claimed attempt to both completion paths", async () => {
    const fixture = createOutboxFixture();
    const successfulMessage = await appendMessage(fixture);
    const failedMessage = await appendMessage(fixture, {
      idempotencyKey: "credit-acct-2",
    });
    const processedSpy = vi.spyOn(fixture.store, "markInboxProcessed");
    const failedSpy = vi.spyOn(fixture.store, "markInboxFailed");
    const consumer = new TransactionalInboxConsumer({
      store: fixture.store,
      consumerId: "claim-projection",
      now: fixture.clock.now,
      throwOnError: false,
    });

    await consumer.handle(successfulMessage, async () => {
      throw new Error("first success-path attempt failed");
    });
    await consumer.handle(failedMessage, async () => {
      throw new Error("first failure-path attempt failed");
    });
    processedSpy.mockClear();
    failedSpy.mockClear();

    await consumer.handle(successfulMessage, async () => {});
    await consumer.handle(failedMessage, async () => {
      throw new Error("projection offline");
    });

    expect(processedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ expectedAttempts: 2 }),
      undefined,
    );
    expect(failedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ expectedAttempts: 2 }),
      undefined,
    );
  });

  it("does not reinterpret a success completion conflict as a handler failure", async () => {
    const fixture = createOutboxFixture();
    const message = await appendMessage(fixture);
    const conflict = new InboxClaimConflictProblem(
      "claim-projection",
      message.idempotencyKey,
      1,
      2,
      "processing",
    );
    vi.spyOn(fixture.store, "markInboxProcessed").mockRejectedValue(conflict);
    const failedSpy = vi.spyOn(fixture.store, "markInboxFailed");
    const consumer = new TransactionalInboxConsumer({
      store: fixture.store,
      consumerId: "claim-projection",
      now: fixture.clock.now,
    });

    await expect(consumer.handle(message, async () => {})).rejects.toBe(conflict);
    expect(failedSpy).not.toHaveBeenCalled();
  });

  it("completes inbox processing when handler execution exceeds visibility timeout without a concurrent reclaim and deduplicates subsequent delivery", async () => {
    const fixture = createOutboxFixture();
    const message = await appendMessage(fixture);
    const consumer = new TransactionalInboxConsumer({
      store: fixture.store,
      consumerId: "timeout-projection",
      visibilityTimeoutMs: 1_000,
      now: fixture.clock.now,
    });

    let handlerCalls = 0;
    const result = await consumer.handle(message, async () => {
      handlerCalls++;
      fixture.clock.advance(2_000);
    });

    expect(result).toMatchObject({
      status: "processed",
      record: { attempts: 1, status: "processed" },
    });
    expect(handlerCalls).toBe(1);

    const redelivery = await consumer.handle(message, async () => {
      handlerCalls++;
    });

    expect(redelivery).toMatchObject({
      status: "duplicate",
      record: { status: "processed", attempts: 1 },
    });
    expect(handlerCalls).toBe(1);
  });

  it("recovers handler success after inbox completion persistence fails", async () => {
    const fixture = createOutboxFixture();
    const message = await appendMessage(fixture);
    const markProcessed = fixture.store.markInboxProcessed.bind(fixture.store);
    vi.spyOn(fixture.store, "markInboxProcessed")
      .mockRejectedValueOnce(new OutboxStorageProblem("completion persistence unavailable"))
      .mockImplementation((input, context) => markProcessed(input, context));
    const handler = vi.fn(async () => {});
    const consumer = new TransactionalInboxConsumer({
      store: fixture.store,
      consumerId: "recovery-projection",
      visibilityTimeoutMs: 1_000,
      now: fixture.clock.now,
    });

    await expect(consumer.handle(message, handler)).rejects.toMatchObject({
      code: "events-tx/storage-error",
    });
    await expect(
      fixture.store.findInboxRecord("recovery-projection", message.idempotencyKey),
    ).resolves.toMatchObject({
      status: "processing",
      attempts: 1,
      lockedUntil: new Date("2026-01-01T00:00:01.000Z"),
    });

    fixture.clock.advance(1_000);
    await expect(consumer.handle(message, handler)).resolves.toMatchObject({
      status: "processed",
      record: {
        attempts: 2,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "events-tx/inbox-lease-reclaimed" }),
        ]),
      },
    });
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe("createEventBusOutboxPublisher", () => {
  it("publishes deserialized outbox messages to an EventBus", async () => {
    const fixture = createOutboxFixture();
    const message = await appendMessage(fixture);
    const published: DomainEvent[] = [];
    const eventBus: EventBus = {
      publish: async (event) => {
        published.push(event);
      },
      subscribe: () => {},
      unsubscribe: () => {},
      clear: () => {},
    };
    const serializer = new DefaultEventSerializer(
      new EventRegistry().register(AccountCreditedEvent),
    );

    await createEventBusOutboxPublisher(eventBus, serializer)(message);

    expect(published).toHaveLength(1);
    expect(published[0]).toBeInstanceOf(AccountCreditedEvent);
    expect((published[0] as AccountCreditedEvent).accountId).toBe("acct-1");
  });

  it("preserves trace context metadata when publishing to an EventBus", async () => {
    const fixture = createOutboxFixture();
    const message = await appendMessage(fixture);
    const published: DomainEvent[] = [];
    const eventBus: EventBus = {
      publish: async (event) => {
        published.push(event);
      },
      subscribe: () => {},
      unsubscribe: () => {},
      clear: () => {},
    };
    const serializer = new DefaultEventSerializer(
      new EventRegistry().register(AccountCreditedEvent),
    );

    await createEventBusOutboxPublisher(
      eventBus,
      serializer,
    )({
      ...message,
      metadata: {
        source: "outbox",
      },
      traceContext: {
        traceId: "trace-1",
        spanId: "span-1",
        traceFlags: 1,
        isValid: true,
      },
    });

    expect(published[0].metadata).toMatchObject({
      source: "outbox",
      traceContext: {
        traceId: "trace-1",
        spanId: "span-1",
      },
    });
  });
});

describe("TransactionalEventStore conformance", () => {
  it("keeps delimiter-colliding inbox identities independent", async () => {
    const fixture = createOutboxFixture();
    const now = fixture.clock.now();
    const firstIdentity = {
      consumerId: "a:b",
      messageId: "message-first",
      inboxKey: "c",
      eventType: "first.event",
    };
    const secondIdentity = {
      consumerId: "a",
      messageId: "message-second",
      inboxKey: "b:c",
      eventType: "second.event",
    };
    const firstInput = {
      ...firstIdentity,
      now,
    };
    const secondInput = {
      ...secondIdentity,
      now,
    };

    const first = await fixture.store.startInboxProcessing(firstInput);
    const second = await fixture.store.startInboxProcessing(secondInput);
    const exactDuplicate = await fixture.store.startInboxProcessing(secondInput);

    expect(first).toMatchObject({ status: "started", record: firstIdentity });
    expect(second).toMatchObject({ status: "started", record: secondIdentity });
    expect(exactDuplicate).toMatchObject({ status: "duplicate", record: secondIdentity });

    await fixture.store.markInboxProcessed({
      consumerId: firstInput.consumerId,
      inboxKey: firstInput.inboxKey,
      expectedAttempts: first.record.attempts,
      now,
    });
    await fixture.store.markInboxFailed({
      consumerId: secondInput.consumerId,
      inboxKey: secondInput.inboxKey,
      expectedAttempts: second.record.attempts,
      now,
      error: { name: "Error", message: "second failed" },
      reason: "second failed",
    });

    await expect(
      fixture.store.findInboxRecord(firstInput.consumerId, firstInput.inboxKey),
    ).resolves.toMatchObject({
      ...firstIdentity,
      status: "processed",
    });
    await expect(
      fixture.store.findInboxRecord(secondInput.consumerId, secondInput.inboxKey),
    ).resolves.toMatchObject({
      ...secondIdentity,
      status: "failed",
      failureReason: "second failed",
    });
    await expect(fixture.store.listInboxRecords()).resolves.toHaveLength(2);
  });

  it("provides deterministic append, claim, publish, and inbox state transitions", async () => {
    const fixture = createOutboxFixture();
    const message = await appendMessage(fixture);
    await expect(fixture.store.findOutboxByIdempotencyKey("credit-acct-1")).resolves.toMatchObject({
      id: message.id,
    });

    const claimed = await fixture.store.claimOutboxBatch({
      limit: 10,
      now: fixture.clock.now(),
      visibilityTimeoutMs: 5_000,
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ attempts: 1, status: "publishing" });

    await fixture.store.markOutboxPublished({
      id: claimed[0].id,
      expectedAttempts: claimed[0].attempts,
      now: fixture.clock.now(),
    });
    await expect(fixture.store.listOutboxMessages({ status: "published" })).resolves.toHaveLength(
      1,
    );

    const started = await fixture.store.startInboxProcessing({
      consumerId: "projection",
      messageId: message.id,
      inboxKey: message.idempotencyKey,
      eventType: message.eventType,
      now: fixture.clock.now(),
    });
    expect(started.status).toBe("started");
    await fixture.store.markInboxProcessed({
      consumerId: "projection",
      inboxKey: message.idempotencyKey,
      expectedAttempts: started.record.attempts,
      now: fixture.clock.now(),
    });
    const duplicate = await fixture.store.startInboxProcessing({
      consumerId: "projection",
      messageId: message.id,
      inboxKey: message.idempotencyKey,
      eventType: message.eventType,
      now: fixture.clock.now(),
    });
    expect(duplicate.status).toBe("duplicate");
  });

  it("keeps committed state isolated from mutated results and supports filtered inbox listing", async () => {
    const fixture = createOutboxFixture();
    const message = await appendMessage(fixture);
    const [listed] = await fixture.store.listOutboxMessages();

    listed.payload.amount = 999;
    listed.metadata.changed = true;

    await expect(fixture.store.findOutboxById(message.id)).resolves.toMatchObject({
      payload: {
        amount: 100,
      },
      metadata: {},
    });

    const ledgerStarted = await fixture.store.startInboxProcessing({
      consumerId: "ledger-projection",
      messageId: message.id,
      inboxKey: message.idempotencyKey,
      eventType: message.eventType,
      now: fixture.clock.now(),
    });
    await fixture.store.markInboxFailed({
      consumerId: "ledger-projection",
      inboxKey: message.idempotencyKey,
      expectedAttempts: ledgerStarted.record.attempts,
      now: fixture.clock.now(),
      error: {
        name: "Error",
        message: "projection offline",
      },
      reason: "projection offline",
    });
    await fixture.store.startInboxProcessing({
      consumerId: "audit-projection",
      messageId: "message-2",
      inboxKey: "credit-acct-2",
      eventType: message.eventType,
      now: fixture.clock.now(),
    });

    await expect(
      fixture.store.listInboxRecords({
        consumerId: "ledger-projection",
        status: "failed",
        limit: 1,
      }),
    ).resolves.toMatchObject([
      {
        consumerId: "ledger-projection",
        status: "failed",
      },
    ]);
    await expect(fixture.store.listInboxRecords()).resolves.toHaveLength(2);
  });

  it("returns one duplicate when concurrent direct starts target the same inbox key", async () => {
    const fixture = createOutboxFixture();
    const message = await appendMessage(fixture);
    const input = {
      consumerId: "ledger-projection",
      messageId: message.id,
      inboxKey: message.idempotencyKey,
      eventType: message.eventType,
      now: fixture.clock.now(),
    };

    const starts = await Promise.all([
      fixture.store.startInboxProcessing(input),
      fixture.store.startInboxProcessing(input),
    ]);

    expect(starts.map(({ status }) => status).sort()).toEqual(["duplicate", "started"]);
    expect(starts[0].record).toEqual(starts[1].record);
  });

  it("reclaims an expired in-memory inbox lease and fences the stale attempt", async () => {
    const fixture = createOutboxFixture();
    const message = await appendMessage(fixture);
    const startInput = {
      consumerId: "ledger-projection",
      messageId: message.id,
      inboxKey: message.idempotencyKey,
      eventType: message.eventType,
      visibilityTimeoutMs: 1_000,
    };
    const first = await fixture.store.startInboxProcessing({
      ...startInput,
      now: fixture.clock.now(),
    });

    const duplicate = await fixture.store.startInboxProcessing({
      ...startInput,
      now: fixture.clock.advance(999),
    });
    const reclaimed = await fixture.store.startInboxProcessing({
      ...startInput,
      now: fixture.clock.advance(1),
    });

    expect(duplicate).toMatchObject({ status: "duplicate", record: { attempts: 1 } });
    expect(reclaimed).toMatchObject({
      status: "started",
      record: {
        attempts: 2,
        lockedUntil: new Date("2026-01-01T00:00:02.000Z"),
        diagnostics: [
          expect.anything(),
          expect.objectContaining({ code: "events-tx/inbox-lease-reclaimed" }),
        ],
      },
    });
    await expect(
      fixture.store.markInboxProcessed({
        consumerId: startInput.consumerId,
        inboxKey: startInput.inboxKey,
        expectedAttempts: first.record.attempts,
        now: fixture.clock.now(),
      }),
    ).rejects.toMatchObject({
      code: "events-tx/inbox-claim-conflict",
      extensions: { expectedAttempts: 1, actualAttempts: 2, actualStatus: "processing" },
    });
    const processed = await fixture.store.markInboxProcessed({
      consumerId: startInput.consumerId,
      inboxKey: startInput.inboxKey,
      expectedAttempts: reclaimed.record.attempts,
      now: fixture.clock.now(),
    });
    expect(processed).toMatchObject({ status: "processed", attempts: 2 });
    expect(processed).not.toHaveProperty("lockedUntil");
  });

  it("completes in-memory inbox processing when lease expires without a concurrent reclaim", async () => {
    const fixture = createOutboxFixture();
    const message = await appendMessage(fixture);
    const started = await fixture.store.startInboxProcessing({
      consumerId: "ledger-projection",
      messageId: message.id,
      inboxKey: message.idempotencyKey,
      eventType: message.eventType,
      now: fixture.clock.now(),
      visibilityTimeoutMs: 1_000,
    });

    const processed = await fixture.store.markInboxProcessed({
      consumerId: "ledger-projection",
      inboxKey: message.idempotencyKey,
      expectedAttempts: started.record.attempts,
      now: fixture.clock.advance(1_000),
    });
    expect(processed).toMatchObject({ status: "processed", attempts: 1 });
    expect(processed).not.toHaveProperty("lockedUntil");
    await expect(
      fixture.store.findInboxRecord("ledger-projection", message.idempotencyKey),
    ).resolves.toMatchObject({ status: "processed", attempts: 1 });

    const redelivered = await fixture.store.startInboxProcessing({
      consumerId: "ledger-projection",
      messageId: message.id,
      inboxKey: message.idempotencyKey,
      eventType: message.eventType,
      now: fixture.clock.advance(1_000),
      visibilityTimeoutMs: 1_000,
    });
    expect(redelivered).toMatchObject({
      status: "duplicate",
      record: { status: "processed", attempts: 1 },
    });
  });

  it("completes in-memory inbox failure when lease expires without a concurrent reclaim", async () => {
    const fixture = createOutboxFixture();
    const message = await appendMessage(fixture);
    const started = await fixture.store.startInboxProcessing({
      consumerId: "ledger-projection",
      messageId: message.id,
      inboxKey: message.idempotencyKey,
      eventType: message.eventType,
      now: fixture.clock.now(),
      visibilityTimeoutMs: 1_000,
    });

    const failed = await fixture.store.markInboxFailed({
      consumerId: "ledger-projection",
      inboxKey: message.idempotencyKey,
      expectedAttempts: started.record.attempts,
      now: fixture.clock.advance(1_000),
      error: { name: "Error", message: "timeout error" },
      reason: "timeout error",
    });
    expect(failed).toMatchObject({ status: "failed", attempts: 1 });
    expect(failed).not.toHaveProperty("lockedUntil");
    await expect(
      fixture.store.findInboxRecord("ledger-projection", message.idempotencyKey),
    ).resolves.toMatchObject({ status: "failed", attempts: 1 });
  });

  it("rejects stale inbox success after a newer retry without mutating the active claim", async () => {
    const fixture = createOutboxFixture();
    const message = await appendMessage(fixture);
    const first = await fixture.store.startInboxProcessing({
      consumerId: "ledger-projection",
      messageId: message.id,
      inboxKey: message.idempotencyKey,
      eventType: message.eventType,
      now: fixture.clock.now(),
    });
    await fixture.store.markInboxFailed({
      consumerId: "ledger-projection",
      inboxKey: message.idempotencyKey,
      expectedAttempts: first.record.attempts,
      now: fixture.clock.now(),
      error: { name: "Error", message: "projection offline" },
      reason: "projection offline",
    });
    const retry = await fixture.store.startInboxProcessing({
      consumerId: "ledger-projection",
      messageId: message.id,
      inboxKey: message.idempotencyKey,
      eventType: message.eventType,
      now: fixture.clock.now(),
    });
    const before = await fixture.store.findInboxRecord("ledger-projection", message.idempotencyKey);

    await expect(
      fixture.store.markInboxProcessed({
        consumerId: "ledger-projection",
        inboxKey: message.idempotencyKey,
        expectedAttempts: first.record.attempts,
        now: fixture.clock.advance(1_000),
      }),
    ).rejects.toMatchObject({
      code: "events-tx/inbox-claim-conflict",
      extensions: {
        expectedAttempts: 1,
        actualAttempts: 2,
        actualStatus: "processing",
      },
    });
    expect(retry.record.attempts).toBe(2);
    await expect(
      fixture.store.findInboxRecord("ledger-projection", message.idempotencyKey),
    ).resolves.toEqual(before);
  });

  it("rejects a late inbox failure after success without changing terminal evidence", async () => {
    const fixture = createOutboxFixture();
    const message = await appendMessage(fixture);
    const started = await fixture.store.startInboxProcessing({
      consumerId: "ledger-projection",
      messageId: message.id,
      inboxKey: message.idempotencyKey,
      eventType: message.eventType,
      now: fixture.clock.now(),
    });
    await fixture.store.markInboxProcessed({
      consumerId: "ledger-projection",
      inboxKey: message.idempotencyKey,
      expectedAttempts: started.record.attempts,
      now: fixture.clock.now(),
    });
    const before = await fixture.store.findInboxRecord("ledger-projection", message.idempotencyKey);

    await expect(
      fixture.store.markInboxFailed({
        consumerId: "ledger-projection",
        inboxKey: message.idempotencyKey,
        expectedAttempts: started.record.attempts,
        now: fixture.clock.advance(1_000),
        error: { name: "Error", message: "late failure" },
        reason: "late failure",
      }),
    ).rejects.toBeInstanceOf(InboxClaimConflictProblem);
    await expect(
      fixture.store.findInboxRecord("ledger-projection", message.idempotencyKey),
    ).resolves.toEqual(before);
  });

  it("allows exactly one terminal completion for the same inbox claim", async () => {
    const fixture = createOutboxFixture();
    const message = await appendMessage(fixture);
    const started = await fixture.store.startInboxProcessing({
      consumerId: "ledger-projection",
      messageId: message.id,
      inboxKey: message.idempotencyKey,
      eventType: message.eventType,
      now: fixture.clock.now(),
    });
    const completion = {
      consumerId: "ledger-projection",
      inboxKey: message.idempotencyKey,
      expectedAttempts: started.record.attempts,
      now: fixture.clock.now(),
    };

    const completions = [
      {
        status: "processed" as const,
        promise: fixture.store.markInboxProcessed(completion),
      },
      {
        status: "failed" as const,
        promise: fixture.store.markInboxFailed({
          ...completion,
          error: { name: "Error", message: "racing failure" },
          reason: "racing failure",
        }),
      },
    ];
    const results = await Promise.allSettled(completions.map(({ promise }) => promise));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([
      {
        reason: {
          code: "events-tx/inbox-claim-conflict",
        },
      },
    ]);
    const winnerIndex = results.findIndex((result) => result.status === "fulfilled");
    const expectedStatus = completions[winnerIndex]?.status;
    expect(expectedStatus).toBeDefined();
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([
      {
        reason: {
          extensions: { actualStatus: expectedStatus },
        },
      },
    ]);
    await expect(
      fixture.store.findInboxRecord("ledger-projection", message.idempotencyKey),
    ).resolves.toMatchObject({ status: expectedStatus });
  });

  it("commits only one in-memory transaction for the same completion claim", async () => {
    const fixture = createOutboxFixture();
    const message = await appendMessage(fixture);
    const started = await fixture.store.startInboxProcessing({
      consumerId: "ledger-projection",
      messageId: message.id,
      inboxKey: message.idempotencyKey,
      eventType: message.eventType,
      now: fixture.clock.now(),
    });
    const adapter = fixture.store.createTxAdapter();
    let releaseFirstTransaction = (): void => {};
    const firstTransactionGate = new Promise<void>((resolve) => {
      releaseFirstTransaction = resolve;
    });
    const completion = {
      consumerId: "ledger-projection",
      inboxKey: message.idempotencyKey,
      expectedAttempts: started.record.attempts,
      now: fixture.clock.now(),
    };

    const processed = adapter.transaction(async (client) => {
      const record = await fixture.store.markInboxProcessed(completion, { client });
      await firstTransactionGate;
      return record;
    });
    const failed = adapter.transaction(async (client) => {
      return fixture.store.markInboxFailed(
        {
          ...completion,
          error: { name: "Error", message: "racing failure" },
          reason: "racing failure",
        },
        { client },
      );
    });

    await expect(failed).resolves.toMatchObject({ status: "failed", attempts: 1 });
    releaseFirstTransaction();
    await expect(processed).rejects.toMatchObject({
      code: "events-tx/inbox-claim-conflict",
    });
    await expect(
      fixture.store.findInboxRecord("ledger-projection", message.idempotencyKey),
    ).resolves.toMatchObject({ status: "failed", attempts: 1 });
  });

  it("allows only one completion across transaction and direct in-memory paths", async () => {
    const fixture = createOutboxFixture();
    const message = await appendMessage(fixture);
    const started = await fixture.store.startInboxProcessing({
      consumerId: "ledger-projection",
      messageId: message.id,
      inboxKey: message.idempotencyKey,
      eventType: message.eventType,
      now: fixture.clock.now(),
    });
    const adapter = fixture.store.createTxAdapter();
    let releaseTransaction = (): void => {};
    const transactionGate = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    const completion = {
      consumerId: "ledger-projection",
      inboxKey: message.idempotencyKey,
      expectedAttempts: started.record.attempts,
      now: fixture.clock.now(),
    };
    const processed = adapter.transaction(async (client) => {
      const record = await fixture.store.markInboxProcessed(completion, { client });
      await transactionGate;
      return record;
    });
    const failed = fixture.store.markInboxFailed({
      ...completion,
      error: { name: "Error", message: "racing failure" },
      reason: "racing failure",
    });

    await expect(failed).resolves.toMatchObject({ status: "failed", attempts: 1 });
    releaseTransaction();
    await expect(processed).rejects.toMatchObject({
      code: "events-tx/inbox-claim-conflict",
    });
    await expect(
      fixture.store.findInboxRecord("ledger-projection", message.idempotencyKey),
    ).resolves.toMatchObject({ status: "failed", attempts: 1 });
  });

  it("reports the rejected retry attempt when concurrent transactions complete attempt two", async () => {
    const fixture = createOutboxFixture();
    const message = await appendMessage(fixture);
    const firstAttempt = await fixture.store.startInboxProcessing({
      consumerId: "ledger-projection",
      messageId: message.id,
      inboxKey: message.idempotencyKey,
      eventType: message.eventType,
      now: fixture.clock.now(),
    });
    await fixture.store.markInboxFailed({
      consumerId: "ledger-projection",
      inboxKey: message.idempotencyKey,
      expectedAttempts: firstAttempt.record.attempts,
      now: fixture.clock.now(),
      error: { name: "Error", message: "first failure" },
      reason: "first failure",
    });
    const adapter = fixture.store.createTxAdapter();
    let releaseFirstRetry = (): void => {};
    const firstRetryGate = new Promise<void>((resolve) => {
      releaseFirstRetry = resolve;
    });
    const retryInput = {
      consumerId: "ledger-projection",
      messageId: message.id,
      inboxKey: message.idempotencyKey,
      eventType: message.eventType,
      now: fixture.clock.now(),
    };

    const processed = adapter.transaction(async (client) => {
      const retry = await fixture.store.startInboxProcessing(retryInput, { client });
      expect(retry.record.attempts).toBe(2);
      const record = await fixture.store.markInboxProcessed(
        {
          consumerId: "ledger-projection",
          inboxKey: message.idempotencyKey,
          expectedAttempts: retry.record.attempts,
          now: fixture.clock.now(),
        },
        { client },
      );
      await firstRetryGate;
      return record;
    });
    const failed = adapter.transaction(async (client) => {
      const retry = await fixture.store.startInboxProcessing(retryInput, { client });
      expect(retry.record.attempts).toBe(2);
      return fixture.store.markInboxFailed(
        {
          consumerId: "ledger-projection",
          inboxKey: message.idempotencyKey,
          expectedAttempts: retry.record.attempts,
          now: fixture.clock.now(),
          error: { name: "Error", message: "second failure" },
          reason: "second failure",
        },
        { client },
      );
    });

    await expect(failed).resolves.toMatchObject({ status: "failed", attempts: 2 });
    releaseFirstRetry();
    await expect(processed).rejects.toMatchObject({
      code: "events-tx/inbox-claim-conflict",
      extensions: {
        expectedAttempts: 2,
        actualAttempts: 2,
        actualStatus: "failed",
      },
    });
  });

  it("merges a nested requires-new transaction without deadlocking its outer transaction", async () => {
    const fixture = createOutboxFixture();

    await fixture.txManager.run(async () => {
      await fixture.outbox.append(new AccountCreditedEvent("acct-outer", 100), {
        idempotencyKey: "credit-outer",
      });
      await fixture.txManager.suspend(() =>
        fixture.txManager.run(() =>
          fixture.outbox.append(new AccountCreditedEvent("acct-inner", 200), {
            idempotencyKey: "credit-inner",
          }),
        ),
      );
    });

    await expect(fixture.store.listOutboxMessages()).resolves.toMatchObject([
      { idempotencyKey: "credit-inner" },
      { idempotencyKey: "credit-outer" },
    ]);
  });

  it("invalidates in-flight transaction snapshots when the store is cleared", async () => {
    const store = new InMemoryTransactionalEventStore();
    const adapter = store.createTxAdapter();
    let releaseTransaction = (): void => {};
    let markTransactionStarted = (): void => {};
    const transactionGate = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    const transactionStarted = new Promise<void>((resolve) => {
      markTransactionStarted = resolve;
    });
    const createMessage = (id: string) => ({
      id,
      eventId: `event-${id}`,
      eventType: "account.credited",
      aggregateId: `acct-${id}`,
      idempotencyKey: `credit-${id}`,
      payload: { accountId: `acct-${id}`, amount: 100 },
      metadata: {},
      maxAttempts: 3,
      visibleAt: new Date("2026-01-01T00:00:00.000Z"),
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const staleTransaction = adapter.transaction(async (client) => {
      await store.appendOutbox(createMessage("before-clear"), { client });
      markTransactionStarted();
      await transactionGate;
    });
    const staleTransactionResult = expect(staleTransaction).rejects.toMatchObject({
      code: "events-tx/storage-error",
    });

    await transactionStarted;
    store.clear();
    releaseTransaction();
    await staleTransactionResult;
    await expect(store.listOutboxMessages()).resolves.toEqual([]);

    await adapter.transaction((client) =>
      store.appendOutbox(createMessage("after-clear"), { client }),
    );
    await expect(store.listOutboxMessages()).resolves.toMatchObject([
      { id: "after-clear", idempotencyKey: "credit-after-clear" },
    ]);
  });

  it("throws storage problems for missing outbox and inbox records", async () => {
    const fixture = createOutboxFixture();

    await expect(
      fixture.store.markOutboxPublished({
        id: "missing-message",
        expectedAttempts: 1,
        now: fixture.clock.now(),
      }),
    ).rejects.toBeInstanceOf(OutboxStorageProblem);
    await expect(
      fixture.store.markInboxProcessed({
        consumerId: "projection",
        inboxKey: "missing-key",
        expectedAttempts: 1,
        now: fixture.clock.now(),
      }),
    ).rejects.toBeInstanceOf(OutboxStorageProblem);
    await expect(fixture.store.findOutboxById("missing-message")).resolves.toBeNull();
  });

  it("honors abort signals before and after in-memory transaction work", async () => {
    const store = new InMemoryTransactionalEventStore();
    const adapter = store.createTxAdapter();
    const abortedBefore = new AbortController();
    abortedBefore.abort(new Error("transaction cancelled"));

    await expect(
      adapter.transaction(async () => undefined, undefined, abortedBefore.signal),
    ).rejects.toThrow("transaction cancelled");

    const abortedAfter = new AbortController();
    await expect(
      adapter.transaction(
        async () => {
          abortedAfter.abort("cancelled");
        },
        undefined,
        abortedAfter.signal,
      ),
    ).rejects.toThrow("Transaction aborted");
  });
});

describe("DrizzleTransactionalEventStore", () => {
  it("keeps delimiter-colliding inbox identities independent", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const firstIdentity = {
      consumerId: "a:b",
      messageId: "message-first",
      inboxKey: "c",
      eventType: "first.event",
    };
    const secondIdentity = {
      consumerId: "a",
      messageId: "message-second",
      inboxKey: "b:c",
      eventType: "second.event",
    };
    const first = inboxRowValues(firstIdentity);
    const second = inboxRowValues(secondIdentity);
    const processedFirst = inboxRowValues({ ...firstIdentity, status: "processed" });
    const failedSecond = inboxRowValues({
      ...secondIdentity,
      status: "failed",
      failureReason: "second failed",
    });
    const proxy = createInboxProxyDb([
      [],
      [first],
      [],
      [second],
      [second],
      [first],
      [processedFirst],
      [second],
      [failedSecond],
      [processedFirst],
      [failedSecond],
    ]);
    const store = new DrizzleTransactionalEventStore({ db: proxy.db });

    const firstStart = await store.startInboxProcessing({ ...firstIdentity, now });
    const secondStart = await store.startInboxProcessing({ ...secondIdentity, now });
    const exactDuplicate = await store.startInboxProcessing({ ...secondIdentity, now });

    expect(firstStart).toMatchObject({ status: "started", record: firstIdentity });
    expect(secondStart).toMatchObject({ status: "started", record: secondIdentity });
    expect(exactDuplicate).toMatchObject({ status: "duplicate", record: secondIdentity });

    await store.markInboxProcessed({
      consumerId: firstIdentity.consumerId,
      inboxKey: firstIdentity.inboxKey,
      expectedAttempts: firstStart.record.attempts,
      now,
    });
    await store.markInboxFailed({
      consumerId: secondIdentity.consumerId,
      inboxKey: secondIdentity.inboxKey,
      expectedAttempts: secondStart.record.attempts,
      now,
      error: { name: "Error", message: "second failed" },
      reason: "second failed",
    });

    await expect(
      store.findInboxRecord(firstIdentity.consumerId, firstIdentity.inboxKey),
    ).resolves.toMatchObject({ ...firstIdentity, status: "processed" });
    await expect(
      store.findInboxRecord(secondIdentity.consumerId, secondIdentity.inboxKey),
    ).resolves.toMatchObject({
      ...secondIdentity,
      status: "failed",
      failureReason: "second failed",
    });
    const selectParameters = proxy.queries
      .filter(({ sql }) => sql.startsWith("select"))
      .map(({ params }) => params.slice(0, 2));
    expect(selectParameters).toEqual([
      [firstIdentity.consumerId, firstIdentity.inboxKey],
      [secondIdentity.consumerId, secondIdentity.inboxKey],
      [secondIdentity.consumerId, secondIdentity.inboxKey],
      [firstIdentity.consumerId, firstIdentity.inboxKey],
      [secondIdentity.consumerId, secondIdentity.inboxKey],
      [firstIdentity.consumerId, firstIdentity.inboxKey],
      [secondIdentity.consumerId, secondIdentity.inboxKey],
    ]);
    const insertQueries = proxy.queries.filter(({ sql }) => sql.startsWith("insert"));
    expect(insertQueries).toHaveLength(2);
    for (const { sql } of insertQueries) {
      expect(sql).toContain('on conflict ("consumer_id","inbox_key") do nothing');
    }
    const updateParameters = proxy.queries
      .filter(({ sql }) => sql.startsWith("update"))
      .map(({ params }) => params.slice(-4, -2));
    expect(updateParameters).toEqual([
      [firstIdentity.consumerId, firstIdentity.inboxKey],
      [secondIdentity.consumerId, secondIdentity.inboxKey],
    ]);
  });

  it("uses the transaction client passed by tx-core context instead of the root db", async () => {
    const rootDb = createMockDrizzleDb({ failInsert: true });
    const txDb = createMockDrizzleDb();
    const store = new DrizzleTransactionalEventStore({
      db: rootDb,
    });
    const input = {
      id: "message-1",
      eventId: "event-1",
      eventType: "account.credited",
      aggregateId: "acct-1",
      idempotencyKey: "credit-acct-1",
      payload: { accountId: "acct-1", amount: 100 },
      metadata: {},
      maxAttempts: 3,
      visibleAt: new Date("2026-01-01T00:00:00.000Z"),
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    };

    await expect(store.appendOutbox(input, { client: txDb })).resolves.toMatchObject({
      id: "message-1",
      eventType: "account.credited",
      status: "pending",
    });
    expect(rootDb.inserts).toHaveLength(0);
    expect(txDb.inserts).toHaveLength(1);
  });

  it("uses conflict-safe outbox append instead of catching unique violations", async () => {
    const existing = createOutboxRow({ id: "message-existing" });
    const db = createMockDrizzleDb({
      insertResults: [[]],
      selectResults: [[], [], [existing]],
    });
    const store = new DrizzleTransactionalEventStore({
      db,
    });

    await expect(
      store.appendOutbox({
        id: "message-1",
        eventId: "event-1",
        eventType: "account.credited",
        aggregateId: "acct-1",
        idempotencyKey: "credit-acct-1",
        payload: { accountId: "acct-1", amount: 100 },
        metadata: {},
        maxAttempts: 3,
        visibleAt: new Date("2026-01-01T00:00:00.000Z"),
        occurredAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      id: "message-existing",
      idempotencyKey: "credit-acct-1",
    });
    expect(db.conflictTargets).toEqual([undefined]);
  });

  it("returns duplicate when a concurrent inbox insert wins the unique key", async () => {
    const existing = createInboxRow({
      consumerId: "ledger-projection",
      inboxKey: "credit-acct-1",
      status: "processing",
    });
    const db = createMockDrizzleDb({
      insertResults: [[]],
      selectResults: [[], [existing]],
    });
    const store = new DrizzleTransactionalEventStore({
      db,
    });

    await expect(
      store.startInboxProcessing({
        consumerId: "ledger-projection",
        messageId: "message-1",
        inboxKey: "credit-acct-1",
        eventType: "account.credited",
        now: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      status: "duplicate",
      record: {
        consumerId: "ledger-projection",
        inboxKey: "credit-acct-1",
      },
    });
    expect(db.conflictTargets).toHaveLength(1);
  });

  it("reclaims an expired Drizzle inbox lease with an attempt-fenced update", async () => {
    const expired = inboxRowValues({
      attempts: 1,
      lockedUntil: new Date("2026-01-01T00:00:01.000Z"),
    });
    const reclaimed = inboxRowValues({
      attempts: 2,
      updatedAt: new Date("2026-01-01T00:00:01.000Z"),
      lockedUntil: new Date("2026-01-01T00:00:02.000Z"),
      diagnostics: [
        {
          code: "events-tx/inbox-lease-reclaimed",
          message: "Expired inbox processing lease reclaimed.",
          at: new Date("2026-01-01T00:00:01.000Z"),
        },
      ],
    });
    const proxy = createInboxProxyDb([[expired], [reclaimed]]);
    const store = new DrizzleTransactionalEventStore({ db: proxy.db });

    await expect(
      store.startInboxProcessing({
        consumerId: "ledger-projection",
        messageId: "message-1",
        inboxKey: "credit-acct-1",
        eventType: "account.credited",
        now: new Date("2026-01-01T00:00:01.000Z"),
        visibilityTimeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({
      status: "started",
      record: {
        attempts: 2,
        lockedUntil: new Date("2026-01-01T00:00:02.000Z"),
      },
    });

    const reclaimSql = proxy.queries[1].sql.slice(proxy.queries[1].sql.indexOf(" where "));
    expect(reclaimSql).toContain('"croco_inbox_records"."attempts"');
    expect(reclaimSql).toContain('"croco_inbox_records"."locked_until"');
    expect(reclaimSql).toContain(" or ");
    expect(reclaimSql).toContain(" <= ");
  });

  it("lets exactly one concurrent Drizzle worker reclaim an expired inbox lease", async () => {
    const expired = inboxRowValues({
      attempts: 1,
      lockedUntil: new Date("2026-01-01T00:00:01.000Z"),
    });
    const reclaimed = inboxRowValues({
      attempts: 2,
      updatedAt: new Date("2026-01-01T00:00:01.000Z"),
      lockedUntil: new Date("2026-01-01T00:00:02.000Z"),
    });
    const proxy = createInboxProxyDb([[expired], [expired], [reclaimed], [], [reclaimed]]);
    const store = new DrizzleTransactionalEventStore({ db: proxy.db });
    const input = {
      consumerId: "ledger-projection",
      messageId: "message-1",
      inboxKey: "credit-acct-1",
      eventType: "account.credited",
      now: new Date("2026-01-01T00:00:01.000Z"),
      visibilityTimeoutMs: 1_000,
    };

    const starts = await Promise.all([
      store.startInboxProcessing(input),
      store.startInboxProcessing(input),
    ]);

    expect(starts.map(({ status }) => status).sort()).toEqual(["duplicate", "started"]);
    expect(starts).toMatchObject([{ record: { attempts: 2 } }, { record: { attempts: 2 } }]);
    expect(
      proxy.queries.filter((query) => query.sql.startsWith("update")).map((query) => query.sql),
    ).toHaveLength(2);
  });

  it("fails closed for a legacy Drizzle processing row without a lease", async () => {
    const legacy = inboxRowValues({ lockedUntil: null });
    const proxy = createInboxProxyDb([[legacy]]);
    const store = new DrizzleTransactionalEventStore({ db: proxy.db });

    const result = await store.startInboxProcessing({
      consumerId: "ledger-projection",
      messageId: "message-1",
      inboxKey: "credit-acct-1",
      eventType: "account.credited",
      now: new Date("2026-01-01T00:01:00.000Z"),
      visibilityTimeoutMs: 1_000,
    });
    expect(result).toMatchObject({
      status: "duplicate",
      record: { status: "processing" },
    });
    expect(result.record).not.toHaveProperty("lockedUntil");
    expect(proxy.queries).toHaveLength(1);
  });

  it("rejects stale Drizzle completion after an expired lease is reclaimed", async () => {
    const reclaimed = inboxRowValues({
      attempts: 2,
      lockedUntil: new Date("2026-01-01T00:00:02.000Z"),
    });
    const proxy = createInboxProxyDb([[reclaimed], [], [reclaimed]]);
    const store = new DrizzleTransactionalEventStore({ db: proxy.db });

    await expect(
      store.markInboxProcessed({
        consumerId: "ledger-projection",
        inboxKey: "credit-acct-1",
        expectedAttempts: 1,
        now: new Date("2026-01-01T00:00:01.000Z"),
      }),
    ).rejects.toMatchObject({
      code: "events-tx/inbox-claim-conflict",
      extensions: { expectedAttempts: 1, actualAttempts: 2, actualStatus: "processing" },
    });
    expect(proxy.queries[1].sql).toContain('"croco_inbox_records"."attempts" =');
    expect(proxy.queries[1].sql).not.toContain('"croco_inbox_records"."locked_until"');
  });

  it("completes Drizzle inbox processing when execution exceeds visibility timeout without reclaim", async () => {
    const processing = inboxRowValues({
      attempts: 1,
      status: "processing",
      lockedUntil: new Date("2026-01-01T00:00:01.000Z"),
    });
    const processed = inboxRowValues({
      attempts: 1,
      status: "processed",
      processedAt: new Date("2026-01-01T00:00:02.000Z"),
      lockedUntil: null,
    });
    const proxy = createInboxProxyDb([[processing], [processed]]);
    const store = new DrizzleTransactionalEventStore({ db: proxy.db });

    const result = await store.markInboxProcessed({
      consumerId: "ledger-projection",
      inboxKey: "credit-acct-1",
      expectedAttempts: 1,
      now: new Date("2026-01-01T00:00:02.000Z"),
    });

    expect(result).toMatchObject({
      status: "processed",
      attempts: 1,
      processedAt: new Date("2026-01-01T00:00:02.000Z"),
    });
    const whereSql = proxy.queries[1].sql.slice(proxy.queries[1].sql.indexOf(" where "));
    expect(whereSql).not.toContain('"croco_inbox_records"."locked_until"');
  });

  it("completes Drizzle inbox failure when execution exceeds visibility timeout without reclaim", async () => {
    const processing = inboxRowValues({
      attempts: 1,
      status: "processing",
      lockedUntil: new Date("2026-01-01T00:00:01.000Z"),
    });
    const failed = inboxRowValues({
      attempts: 1,
      status: "failed",
      failedAt: new Date("2026-01-01T00:00:02.000Z"),
      failureReason: "timeout error",
      lockedUntil: null,
    });
    const proxy = createInboxProxyDb([[processing], [failed]]);
    const store = new DrizzleTransactionalEventStore({ db: proxy.db });

    const result = await store.markInboxFailed({
      consumerId: "ledger-projection",
      inboxKey: "credit-acct-1",
      expectedAttempts: 1,
      now: new Date("2026-01-01T00:00:02.000Z"),
      error: { name: "Error", message: "timeout error" },
      reason: "timeout error",
    });

    expect(result).toMatchObject({
      status: "failed",
      attempts: 1,
      failedAt: new Date("2026-01-01T00:00:02.000Z"),
    });
    expect(result).not.toHaveProperty("lockedUntil");
    const whereSql = proxy.queries[1].sql.slice(proxy.queries[1].sql.indexOf(" where "));
    expect(whereSql).not.toContain('"croco_inbox_records"."locked_until"');
    expect(whereSql.match(/ and /g)).toHaveLength(3);
  });

  it("returns null when a guarded outbox completion updates no rows", async () => {
    const db = createMockDrizzleDb({
      selectResults: [[createOutboxRow({ status: "publishing", attempts: 2 })]],
      updateResults: [[]],
    });
    const store = new DrizzleTransactionalEventStore({
      db,
    });

    await expect(
      store.markOutboxPublished({
        id: "message-1",
        expectedAttempts: 2,
        now: new Date("2026-01-01T00:00:01.000Z"),
      }),
    ).resolves.toBeNull();
    expect(db.updates).toMatchObject([
      {
        status: "published",
      },
    ]);
  });

  it("releases a Drizzle outbox claim without consuming its publish attempt", async () => {
    const now = new Date("2026-01-01T00:00:01.000Z");
    const diagnostic = {
      code: "events-tx/outbox-claim-released",
      message: "Outbox claim released before publication started.",
      at: now,
    };
    const db = createMockDrizzleDb({
      selectResults: [[createOutboxRow({ status: "publishing", attempts: 1 })]],
      updateResults: [
        [
          createOutboxRow({
            status: "retrying",
            attempts: 0,
            visibleAt: now,
            diagnostics: [diagnostic],
          }),
        ],
      ],
    });
    const store = new DrizzleTransactionalEventStore({ db });

    await expect(
      store.releaseOutboxClaim({
        id: "message-1",
        expectedAttempts: 1,
        now,
        diagnostic,
      }),
    ).resolves.toMatchObject({
      status: "retrying",
      attempts: 0,
      visibleAt: now,
      diagnostics: [diagnostic],
    });
    expect(db.updates[0]).toMatchObject({
      status: "retrying",
      attempts: 0,
      visibleAt: now,
      lockedUntil: null,
    });
  });

  it("emits attempt-fenced Drizzle CAS SQL for inbox success and failure", async () => {
    const processing = inboxRowValues({ attempts: 2, status: "processing" });
    const processed = inboxRowValues({
      attempts: 2,
      status: "processed",
      processedAt: new Date("2026-01-01T00:00:01.000Z"),
    });
    const failed = inboxRowValues({
      attempts: 2,
      status: "failed",
      failedAt: new Date("2026-01-01T00:00:01.000Z"),
      failureReason: "projection offline",
    });
    const successProxy = createInboxProxyDb([[processing], [processed]]);
    const failureProxy = createInboxProxyDb([[processing], [failed]]);
    const successStore = new DrizzleTransactionalEventStore({ db: successProxy.db });
    const failureStore = new DrizzleTransactionalEventStore({ db: failureProxy.db });

    await expect(
      successStore.markInboxProcessed({
        consumerId: "ledger-projection",
        inboxKey: "credit-acct-1",
        expectedAttempts: 2,
        now: new Date("2026-01-01T00:00:01.000Z"),
      }),
    ).resolves.toMatchObject({ status: "processed", attempts: 2 });
    await expect(
      failureStore.markInboxFailed({
        consumerId: "ledger-projection",
        inboxKey: "credit-acct-1",
        expectedAttempts: 2,
        now: new Date("2026-01-01T00:00:01.000Z"),
        error: { name: "Error", message: "projection offline" },
        reason: "projection offline",
      }),
    ).resolves.toMatchObject({ status: "failed", attempts: 2 });

    for (const query of [successProxy.queries[1], failureProxy.queries[1]]) {
      const whereSql = query.sql.slice(query.sql.indexOf(" where "));
      expect(whereSql).toContain('"croco_inbox_records"."consumer_id"');
      expect(whereSql).toContain('"croco_inbox_records"."inbox_key"');
      expect(whereSql).toContain('"croco_inbox_records"."status"');
      expect(whereSql).toContain('"croco_inbox_records"."attempts"');
      expect(whereSql).not.toContain('"croco_inbox_records"."locked_until"');
      expect(whereSql.match(/ and /g)).toHaveLength(3);
      expect(whereSql).not.toContain(" or ");
      expect(query.params.slice(-4)).toEqual([
        "ledger-projection",
        "credit-acct-1",
        "processing",
        2,
      ]);
    }
  });

  it("re-reads the current Drizzle inbox record after a lost completion claim", async () => {
    const processing = inboxRowValues({ attempts: 1, status: "processing" });
    const processed = inboxRowValues({
      attempts: 1,
      status: "processed",
      processedAt: new Date("2026-01-01T00:00:01.000Z"),
    });
    const proxy = createInboxProxyDb([[processing], [], [processed]]);
    const store = new DrizzleTransactionalEventStore({ db: proxy.db });

    await expect(
      store.markInboxFailed({
        consumerId: "ledger-projection",
        inboxKey: "credit-acct-1",
        expectedAttempts: 1,
        now: new Date("2026-01-01T00:00:02.000Z"),
        error: { name: "Error", message: "late failure" },
        reason: "late failure",
      }),
    ).rejects.toMatchObject({
      code: "events-tx/inbox-claim-conflict",
      category: ProblemCategory.Conflict,
      extensions: {
        consumerId: "ledger-projection",
        inboxKey: "credit-acct-1",
        expectedAttempts: 1,
        actualAttempts: 1,
        actualStatus: "processed",
      },
    });
    expect(proxy.queries).toHaveLength(3);
    expect(proxy.queries[1].sql).toContain('update "croco_inbox_records"');
    expect(proxy.queries[2].sql).toContain("select");
  });

  it("allows exactly one Drizzle completion to affect a processing claim", async () => {
    const proxy = createStatefulInboxProxyDb({ attempts: 1, status: "processing" });
    const store = new DrizzleTransactionalEventStore({ db: proxy.db });
    const completion = {
      consumerId: "ledger-projection",
      inboxKey: "credit-acct-1",
      expectedAttempts: 1,
      now: new Date("2026-01-01T00:00:01.000Z"),
    };

    const completions = [
      {
        status: "processed" as const,
        promise: store.markInboxProcessed(completion),
      },
      {
        status: "failed" as const,
        promise: store.markInboxFailed({
          ...completion,
          error: { name: "Error", message: "racing failure" },
          reason: "racing failure",
        }),
      },
    ];
    const results = await Promise.allSettled(completions.map(({ promise }) => promise));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([
      {
        reason: {
          code: "events-tx/inbox-claim-conflict",
          extensions: { actualAttempts: 1 },
        },
      },
    ]);
    const winnerIndex = results.findIndex((result) => result.status === "fulfilled");
    const expectedStatus = completions[winnerIndex]?.status;
    expect(expectedStatus).toBeDefined();
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([
      {
        reason: {
          extensions: { actualStatus: expectedStatus },
        },
      },
    ]);
    expect(proxy.affectedRows).toBe(1);
    expect(proxy.current()).toMatchObject({
      status: expectedStatus,
      attempts: 1,
    });
  });

  it("maps persisted Drizzle JSON fields, diagnostics, and optional timestamps", async () => {
    const db = createMockDrizzleDb({
      selectResults: [
        [
          createOutboxRow({
            aggregateId: null,
            payload: JSON.stringify({ accountId: "acct-1", amount: 100 }),
            metadata: JSON.stringify({ source: "db" }),
            traceContext: JSON.stringify({
              traceId: "trace-1",
              spanId: "span-1",
              traceFlags: 1,
              isValid: true,
            }),
            attempts: 0,
            maxAttempts: 1,
            lockedUntil: "2026-01-01T00:00:10.000Z",
            publishedAt: "2026-01-01T00:00:11.000Z",
            lastError: JSON.stringify({
              name: "BrokerError",
              message: "broker unavailable",
              stack: "stack",
              code: "BROKER_UNAVAILABLE",
            }),
            deadLetteredAt: "2026-01-01T00:00:12.000Z",
            deadLetterReason: "exhausted",
            diagnostics: JSON.stringify([
              {
                code: "events-tx/test",
                message: "diagnostic",
                at: "2026-01-01T00:00:00.000Z",
                details: {
                  attempt: 1,
                },
              },
              {
                code: "events-tx/test-two",
                message: "second diagnostic",
                at: "2026-01-01T00:00:01.000Z",
              },
            ]),
          }),
        ],
      ],
    });
    const store = new DrizzleTransactionalEventStore({
      db,
    });

    await expect(store.findOutboxById("message-1")).resolves.toMatchObject({
      id: "message-1",
      payload: {
        accountId: "acct-1",
      },
      metadata: {
        source: "db",
      },
      traceContext: {
        traceId: "trace-1",
        spanId: "span-1",
        traceFlags: 1,
        isValid: true,
      },
      attempts: 0,
      maxAttempts: 1,
      lockedUntil: new Date("2026-01-01T00:00:10.000Z"),
      publishedAt: new Date("2026-01-01T00:00:11.000Z"),
      lastError: {
        name: "BrokerError",
        message: "broker unavailable",
        code: "BROKER_UNAVAILABLE",
      },
      deadLetteredAt: new Date("2026-01-01T00:00:12.000Z"),
      deadLetterReason: "exhausted",
      diagnostics: [
        {
          code: "events-tx/test",
          message: "diagnostic",
          details: {
            attempt: 1,
          },
        },
        {
          code: "events-tx/test-two",
          message: "second diagnostic",
        },
      ],
    });
  });

  it("accepts public empty-string error and diagnostic fields from a failure update", async () => {
    const now = new Date("2026-01-01T00:00:01.000Z");
    const nextVisibleAt = new Date("2026-01-01T00:00:02.000Z");
    const diagnostic = { code: "", message: "", at: now };
    const db = createMockDrizzleDb({
      selectResults: [[createOutboxRow({ status: "publishing", attempts: 1 })]],
      updateResults: [
        [
          createOutboxRow({
            status: "retrying",
            attempts: 1,
            visibleAt: nextVisibleAt,
            lastError: { name: "Error", message: "", stack: "", code: "" },
            diagnostics: [diagnostic],
          }),
        ],
      ],
    });
    const store = new DrizzleTransactionalEventStore({ db });

    await expect(
      store.markOutboxFailed({
        id: "message-1",
        expectedAttempts: 1,
        now,
        nextVisibleAt,
        error: { name: "Error", message: "", stack: "", code: "" },
        diagnostic,
      }),
    ).resolves.toMatchObject({
      status: "retrying",
      lastError: { name: "Error", message: "", stack: "", code: "" },
      diagnostics: [diagnostic],
    });
  });

  it.each([
    ["id", { id: undefined }],
    ["payload", { payload: '{"secret":"do-not-leak"' }],
    ["metadata", { metadata: [] }],
    ["status", { status: "unknown" }],
    ["attempts", { attempts: Number.NaN }],
    ["maxAttempts", { maxAttempts: 0 }],
    ["visibleAt", { visibleAt: "not-a-date" }],
    ["lastError.message", { lastError: { name: "Error" } }],
    ["diagnostics[0].code", { diagnostics: [{ message: "bad", at: new Date() }] }],
  ])("rejects a persisted outbox row with an invalid %s field", async (field, overrides) => {
    const row = createOutboxRow(overrides);
    const db = createMockDrizzleDb({ selectResults: [[row], [row]] });
    const store = new DrizzleTransactionalEventStore({ db });

    await expect(store.findOutboxById("message-1")).rejects.toMatchObject({
      code: "events-tx/storage-error",
      detail: expect.stringContaining(`field '${field}'`),
    });
    await expect(store.findOutboxById("message-1")).rejects.not.toThrow("do-not-leak");
  });

  it.each([
    ["consumerId", { consumerId: "" }],
    ["messageId", { messageId: undefined }],
    ["status", { status: "unknown" }],
    ["attempts", { attempts: Number.POSITIVE_INFINITY }],
    ["createdAt", { createdAt: "not-a-date" }],
    ["metadata", { metadata: "not-json" }],
    ["lastError.name", { lastError: { message: "bad" } }],
    ["diagnostics", { diagnostics: {} }],
  ])("rejects a persisted inbox row with an invalid %s field", async (field, overrides) => {
    const db = createMockDrizzleDb({
      selectResults: [[createInboxRow(overrides)]],
    });
    const store = new DrizzleTransactionalEventStore({ db });

    await expect(store.findInboxRecord("ledger-projection", "credit-acct-1")).rejects.toMatchObject(
      {
        code: "events-tx/storage-error",
        detail: expect.stringContaining(`field '${field}'`),
      },
    );
  });

  it("accepts serialized inbox JSON and date fields", async () => {
    const db = createMockDrizzleDb({
      selectResults: [
        [
          createInboxRow({
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:01.000Z",
            metadata: JSON.stringify({ source: "serialized" }),
            diagnostics: JSON.stringify([]),
          }),
        ],
      ],
    });
    const store = new DrizzleTransactionalEventStore({ db });

    await expect(
      store.findInboxRecord("ledger-projection", "credit-acct-1"),
    ).resolves.toMatchObject({
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:01.000Z"),
      metadata: { source: "serialized" },
      diagnostics: [],
    });
  });
});

describe("transactional event helpers", () => {
  it("normalizes non-Error publish failures and Error codes", () => {
    const coded = new Error("broker unavailable");
    Object.assign(coded, {
      code: "BROKER_UNAVAILABLE",
    });

    expect(normalizeTransactionalEventError(coded)).toMatchObject({
      name: "Error",
      message: "broker unavailable",
      code: "BROKER_UNAVAILABLE",
    });
    expect(normalizeTransactionalEventError("offline")).toEqual({
      name: "Error",
      message: "offline",
    });
  });
});

type MockDrizzleDb = DrizzleTransactionalEventStoreDb & {
  readonly inserts: Record<string, unknown>[];
  readonly updates: Record<string, unknown>[];
  readonly conflictTargets: unknown[];
};

function createOutboxRow(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: "message-1",
    eventId: "event-1",
    eventType: "account.credited",
    aggregateId: "acct-1",
    idempotencyKey: "credit-acct-1",
    payload: { accountId: "acct-1", amount: 100 },
    metadata: {},
    traceContext: null,
    attempts: 0,
    maxAttempts: 3,
    status: "pending",
    visibleAt: new Date("2026-01-01T00:00:00.000Z"),
    occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    lockedUntil: null,
    publishedAt: null,
    lastError: null,
    deadLetteredAt: null,
    deadLetterReason: null,
    diagnostics: [],
    ...overrides,
  };
}

function createInboxRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    consumerId: "ledger-projection",
    messageId: "message-1",
    inboxKey: "credit-acct-1",
    eventType: "account.credited",
    status: "processing",
    attempts: 1,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    lockedUntil: new Date("2026-01-01T00:00:10.000Z"),
    processedAt: null,
    failedAt: null,
    lastError: null,
    failureReason: null,
    metadata: {},
    diagnostics: [],
    ...overrides,
  };
}

function outboxRowValues(overrides: Partial<Record<string, unknown>> = {}): unknown[] {
  const row = createOutboxRow(overrides);
  return [
    row.id,
    row.eventId,
    row.eventType,
    row.aggregateId,
    row.idempotencyKey,
    row.payload,
    row.metadata,
    row.traceContext,
    row.attempts,
    row.maxAttempts,
    row.status,
    row.visibleAt,
    row.occurredAt,
    row.createdAt,
    row.updatedAt,
    row.lockedUntil,
    row.publishedAt,
    row.lastError,
    row.deadLetteredAt,
    row.deadLetterReason,
    row.diagnostics,
  ];
}

type CapturedProxyQuery = {
  sql: string;
  params: unknown[];
  method: "all" | "execute";
};

function inboxRowValues(overrides: Partial<Record<string, unknown>> = {}): unknown[] {
  const row = createInboxRow(overrides);
  return [
    row.consumerId,
    row.messageId,
    row.inboxKey,
    row.eventType,
    row.status,
    row.attempts,
    row.createdAt,
    row.updatedAt,
    row.lockedUntil,
    row.processedAt,
    row.failedAt,
    row.lastError,
    row.failureReason,
    row.metadata,
    row.diagnostics,
  ];
}

function createInboxProxyDb(results: unknown[][][]) {
  const queries: CapturedProxyQuery[] = [];
  const pendingResults = [...results];
  const db = createPgProxyDrizzle(async (sql, params, method) => {
    queries.push({ sql, params, method });
    return { rows: pendingResults.shift() ?? [] };
  });

  return {
    db: db as unknown as DrizzleTransactionalEventStoreDb,
    queries,
  };
}

function createStatefulInboxProxyDb(overrides: Partial<Record<string, unknown>> = {}) {
  const queries: CapturedProxyQuery[] = [];
  let record = createInboxRow(overrides);
  let affectedRows = 0;
  const db = createPgProxyDrizzle(async (sql, params, method) => {
    queries.push({ sql, params, method });
    if (sql.startsWith("select")) {
      return { rows: [inboxRowValues(record)] };
    }

    if (!sql.startsWith("update")) {
      return { rows: [] };
    }

    const [consumerId, inboxKey, expectedStatus, expectedAttempts] = params.slice(-4);
    const ownsClaim =
      record.consumerId === consumerId &&
      record.inboxKey === inboxKey &&
      record.status === expectedStatus &&
      record.attempts === expectedAttempts;
    if (!ownsClaim) {
      return { rows: [] };
    }

    const nextStatus = String(params[0]);
    affectedRows += 1;
    record = {
      ...record,
      status: nextStatus,
      updatedAt: new Date(String(params[1])),
      lockedUntil: null,
      ...(nextStatus === "processed"
        ? { processedAt: new Date(String(params[3])) }
        : {
            failedAt: new Date(String(params[3])),
            lastError: JSON.parse(String(params[4])),
            failureReason: params[5],
          }),
    };
    return { rows: [inboxRowValues(record)] };
  });

  return {
    db: db as unknown as DrizzleTransactionalEventStoreDb,
    queries,
    get affectedRows() {
      return affectedRows;
    },
    current: () => ({ ...record }),
  };
}

function createMockDrizzleDb(
  options: {
    failInsert?: boolean;
    insertResults?: Record<string, unknown>[][];
    selectResults?: Record<string, unknown>[][];
    updateResults?: Record<string, unknown>[][];
  } = {},
): MockDrizzleDb {
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const conflictTargets: unknown[] = [];
  const insertResults = [...(options.insertResults ?? [])];
  const selectResults = [...(options.selectResults ?? [])];
  const updateResults = [...(options.updateResults ?? [])];
  const db: MockDrizzleDb = {
    inserts,
    updates,
    conflictTargets,
    insert: () => ({
      values: (values) => ({
        onConflictDoNothing: (config) => ({
          returning: async () => {
            if (options.failInsert) {
              throw new Error("root db should not be used");
            }
            conflictTargets.push(config?.target);
            inserts.push(values);
            return insertResults.shift() ?? [values];
          },
        }),
        returning: async () => {
          if (options.failInsert) {
            throw new Error("root db should not be used");
          }
          inserts.push(values);
          return insertResults.shift() ?? [values];
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => selectResults.shift() ?? [],
          orderBy: () => ({
            limit: async () => selectResults.shift() ?? [],
          }),
        }),
      }),
    }),
    update: () => ({
      set: (values) => ({
        where: () => ({
          returning: async () => {
            updates.push(values);
            return updateResults.shift() ?? [values];
          },
        }),
      }),
    }),
  };
  return db;
}
