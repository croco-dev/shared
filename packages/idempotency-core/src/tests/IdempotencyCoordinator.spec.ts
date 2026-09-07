import { describe, expect, it, vi } from "vitest";
import {
  createIdempotencyCoordinator,
  createIdempotentHandler,
  type DerivedIdempotencyKey,
  deriveHttpIdempotencyKey,
  deriveIdempotencyKey,
  deriveWebhookIdempotencyKey,
  IdempotencyConflictProblem,
  IdempotencyExecutionIndeterminateProblem,
  IdempotencyCoordinator,
  type IdempotencyCommitOptions,
  type IdempotencyCompletedRecord,
  type IdempotencyFailOptions,
  type IdempotencyFailedRecord,
  IdempotencyReservationStateProblem,
  type IdempotencyReserveOptions,
  InMemoryIdempotencyStore,
  InvalidIdempotencyKeyProblem,
  InvalidIdempotencyTtlProblem,
  type IdempotencyAuditEvent,
} from "../index";

const INVALID_TTLS = [
  -1,
  0,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
  8_640_000_000_000_000,
] as const;

describe("IdempotencyCoordinator", () => {
  it.each(INVALID_TTLS)(
    "rejects hostile ttl %s before handler, audit, or store state changes",
    async (ttlMs) => {
      const events: IdempotencyAuditEvent[] = [];
      const store = new InMemoryIdempotencyStore<string>({
        now: () => new Date("2026-01-01T00:00:00.000Z"),
      });
      const coordinator = createIdempotencyCoordinator({
        store,
        auditSink: {
          recordIdempotency: (event) => {
            events.push(event);
          },
        },
      });
      const key = deriveIdempotencyKey({
        namespace: "invalid-ttl",
        source: { kind: "explicit", key: `ttl-${String(ttlMs)}`, fingerprint: "payload-a" },
      });
      const handler = vi.fn(() => "must-not-run");

      await expect(coordinator.execute({ key, ttlMs }, handler)).rejects.toBeInstanceOf(
        InvalidIdempotencyTtlProblem,
      );

      expect(handler).not.toHaveBeenCalled();
      expect(events).toEqual([]);
      expect(store.size).toBe(0);
    },
  );

  it("executes once and replays the stored success result for repeated calls", async () => {
    const store = new InMemoryIdempotencyStore<{ orderId: string }>();
    const coordinator = new IdempotencyCoordinator({ store });
    const key = deriveIdempotencyKey({
      namespace: "orders",
      tenantId: "tenant-a",
      source: { kind: "explicit", key: "checkout-1", fingerprint: "cart-a" },
    });
    let calls = 0;

    const first = await coordinator.execute({ key }, () => {
      calls += 1;
      return { orderId: "order-1" };
    });
    const second = await coordinator.execute({ key }, () => {
      calls += 1;
      return { orderId: "order-2" };
    });

    expect(first).toMatchObject({ outcome: "executed", response: { orderId: "order-1" } });
    expect(second).toMatchObject({ outcome: "replayed", response: { orderId: "order-1" } });
    expect(calls).toBe(1);
  });

  it("returns in-flight state instead of running the handler while a reservation is active", async () => {
    const store = new InMemoryIdempotencyStore<string>();
    const coordinator = createIdempotencyCoordinator({ store });
    const key = deriveIdempotencyKey({
      namespace: "jobs",
      source: { kind: "explicit", key: "job-1", fingerprint: "payload-a" },
    });
    await store.reserve(key);

    const result = await coordinator.execute({ key }, () => "must-not-run");

    expect(result.outcome).toBe("in-flight");
  });

  it("records audit events for reserved and replayed outcomes", async () => {
    const events: IdempotencyAuditEvent[] = [];
    const store = new InMemoryIdempotencyStore<string>();
    const coordinator = createIdempotencyCoordinator({
      store,
      auditSink: {
        recordIdempotency: (event) => {
          events.push(event);
        },
      },
    });
    const key = deriveIdempotencyKey({
      namespace: "audit",
      tenantId: "tenant-a",
      source: { kind: "explicit", key: "key-1", fingerprint: "payload-a" },
    });

    await coordinator.execute({ key, metadata: { operation: "create" } }, () => "created");
    await coordinator.execute({ key }, () => "ignored");

    expect(events.map((event) => event.type)).toEqual([
      "idempotency.reserved",
      "idempotency.replayed",
    ]);
    expect(events[0]).toMatchObject({
      key: "key-1",
      namespace: "audit",
      tenantId: "tenant-a",
      fingerprint: "payload-a",
    });
  });

  it("records conflict audit events before rethrowing the Problem", async () => {
    const events: IdempotencyAuditEvent[] = [];
    const store = new InMemoryIdempotencyStore<string>();
    const coordinator = createIdempotencyCoordinator({
      store,
      auditSink: {
        recordIdempotency: (event) => {
          events.push(event);
        },
      },
    });
    const key = deriveIdempotencyKey({
      namespace: "audit",
      source: { kind: "explicit", key: "key-1", fingerprint: "payload-a" },
    });
    const conflictingKey = deriveIdempotencyKey({
      namespace: "audit",
      source: { kind: "explicit", key: "key-1", fingerprint: "payload-b" },
    });

    await coordinator.execute({ key }, () => "created");

    await expect(coordinator.execute({ key: conflictingKey }, () => "ignored")).rejects.toThrow(
      IdempotencyConflictProblem,
    );
    expect(events.map((event) => event.type)).toEqual([
      "idempotency.reserved",
      "idempotency.conflict",
    ]);
  });

  it("replays duplicate webhook provider events through the same core API", async () => {
    const store = new InMemoryIdempotencyStore<{ accepted: boolean }>();
    const coordinator = createIdempotencyCoordinator({ store });
    const key = deriveWebhookIdempotencyKey({
      provider: "stripe",
      eventId: "evt_123",
      tenantId: "tenant-a",
    });
    let calls = 0;

    const first = await coordinator.execute({ key }, () => {
      calls += 1;
      return { accepted: true };
    });
    const duplicate = await coordinator.execute({ key }, () => {
      calls += 1;
      return { accepted: false };
    });

    expect(first.outcome).toBe("executed");
    expect(duplicate).toMatchObject({ outcome: "replayed", response: { accepted: true } });
    expect(calls).toBe(1);
  });

  it("can wrap an HTTP middleware-style handler without coupling to a transport package", async () => {
    type HttpContext = {
      readonly tenantId: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly bodyFingerprint: string;
    };

    const store = new InMemoryIdempotencyStore<{ status: number }>();
    const coordinator = createIdempotencyCoordinator({ store });
    const handler = createIdempotentHandler(
      coordinator,
      (context: HttpContext) => ({
        key: deriveHttpIdempotencyKey({
          tenantId: context.tenantId,
          idempotencyKey: context.headers["idempotency-key"],
          method: "POST",
          path: "/orders",
          bodyFingerprint: context.bodyFingerprint,
        }),
      }),
      () => ({ status: 201 }),
    );

    const first = await handler({
      tenantId: "tenant-a",
      headers: { "idempotency-key": "request-1" },
      bodyFingerprint: "body-a",
    });
    const duplicate = await handler({
      tenantId: "tenant-a",
      headers: { "idempotency-key": "request-1" },
      bodyFingerprint: "body-a",
    });

    expect(first.outcome).toBe("executed");
    expect(duplicate.outcome).toBe("replayed");
  });

  it.each([
    new InvalidIdempotencyKeyProblem("invalid input"),
    { code: "REJECTED", status: 422, detail: "business rule rejected" },
    { code: "TERMINAL", status: 503, retryable: false, extensions: { retryable: true } },
    { code: "TERMINAL_EXTENSION", status: 503, extensions: { retryable: false } },
  ])("caches non-retryable handler failure %j until expiry", async (failure) => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const store = new InMemoryIdempotencyStore<string>({ now: () => now });
    const events: IdempotencyAuditEvent[] = [];
    const coordinator = createIdempotencyCoordinator({
      store,
      auditSink: {
        recordIdempotency: (event) => {
          events.push(event);
        },
      },
    });
    const key = deriveIdempotencyKey({
      namespace: "terminal-failure",
      source: { kind: "explicit", key: "key-1", fingerprint: "payload-a" },
    });
    const handler = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue("recovered");

    await expect(coordinator.execute({ key, ttlMs: 1000 }, handler)).rejects.toBe(failure);
    const duplicate = await coordinator.execute({ key, ttlMs: 1000 }, handler);
    expect(duplicate).toMatchObject({
      outcome: "failed",
      record: {
        retryable: false,
        problem: { code: failure.code, status: failure.status },
        metadata: { idempotencyFailurePhase: "handler" },
      },
    });
    if ("detail" in failure) {
      expect(duplicate.record).toMatchObject({ problem: { detail: failure.detail } });
    }
    expect(handler).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).toEqual([
      "idempotency.reserved",
      "idempotency.failed",
    ]);

    now = new Date("2026-01-01T00:00:01.000Z");
    await expect(coordinator.execute({ key, ttlMs: 1000 }, handler)).resolves.toMatchObject({
      outcome: "executed",
      response: "recovered",
    });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it.each([
    { status: 408 },
    { status: 429 },
    { status: 503 },
    { status: 400, retryable: true, extensions: { retryable: false } },
    new InvalidIdempotencyKeyProblem("temporarily blocked", { retryable: true }),
    new Error("connection reset"),
  ])("allows another attempt after retryable handler failure %j", async (failure) => {
    const coordinator = createIdempotencyCoordinator({
      store: new InMemoryIdempotencyStore<string>(),
    });
    const key = deriveIdempotencyKey({
      namespace: "retryable-failure",
      source: { kind: "explicit", key: "key-1", fingerprint: "payload-a" },
    });
    const handler = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue("recovered");
    await expect(coordinator.execute({ key }, handler)).rejects.toBe(failure);
    await expect(coordinator.execute({ key }, handler)).resolves.toMatchObject({
      outcome: "executed",
      response: "recovered",
    });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])(
    "uses the request retry policy result %s before error metadata",
    async (retryable) => {
      const failure = {
        code: "DOMAIN_FAILURE",
        status: retryable ? 400 : 503,
        retryable: !retryable,
      };
      const isRetryable = vi.fn(() => retryable);
      const coordinator = createIdempotencyCoordinator({
        store: new InMemoryIdempotencyStore<string>(),
      });
      const key = deriveIdempotencyKey({
        namespace: "failure-policy",
        source: { kind: "explicit", key: "key-1", fingerprint: "payload-a" },
      });
      const handler = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue("recovered");
      await expect(coordinator.execute({ key, isRetryable }, handler)).rejects.toBe(failure);
      await expect(coordinator.execute({ key, isRetryable }, handler)).resolves.toMatchObject({
        outcome: retryable ? "executed" : "failed",
      });
      expect(handler).toHaveBeenCalledTimes(retryable ? 2 : 1);
      expect(isRetryable).toHaveBeenCalledExactlyOnceWith(failure);
    },
  );

  it("preserves the handler error when its retry policy throws", async () => {
    const failure = new InvalidIdempotencyKeyProblem("invalid input");
    const policyFailure = new Error("policy failed");
    const store = new InMemoryIdempotencyStore<string>();
    const fail = vi.spyOn(store, "fail");
    const coordinator = createIdempotencyCoordinator({ store });
    const key = deriveIdempotencyKey({
      namespace: "failure-policy",
      source: { kind: "explicit", key: "throwing-policy", fingerprint: "payload-a" },
    });
    await expect(
      coordinator.execute(
        {
          key,
          isRetryable: () => {
            throw policyFailure;
          },
        },
        () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(fail).not.toHaveBeenCalled();
    expect(Object.getOwnPropertyDescriptor(failure, "idempotencyFailureRecordError")?.value).toBe(
      policyFailure,
    );
    expect((await store.reserve(key)).outcome).toBe("in-flight");
  });

  it("caches client errors even when their retryable getter throws", async () => {
    const failure = new InvalidIdempotencyKeyProblem("invalid input");
    Object.defineProperty(failure, "retryable", {
      get: () => {
        throw new Error("unreadable retryability");
      },
    });
    const coordinator = createIdempotencyCoordinator({
      store: new InMemoryIdempotencyStore<string>(),
    });
    const key = deriveIdempotencyKey({
      namespace: "failure-policy",
      source: { kind: "explicit", key: "hostile-retryable", fingerprint: "payload-a" },
    });
    const handler = vi.fn(() => {
      throw failure;
    });
    await expect(coordinator.execute({ key }, handler)).rejects.toBe(failure);
    await expect(coordinator.execute({ key }, handler)).resolves.toMatchObject({
      outcome: "failed",
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("stores failure evidence and allows retry after a transient Problem", async () => {
    const store = new InMemoryIdempotencyStore<string>();
    const fail = vi.spyOn(store, "fail");
    const coordinator = createIdempotencyCoordinator({ store });
    const key = deriveIdempotencyKey({
      namespace: "retry",
      source: { kind: "explicit", key: "key-1", fingerprint: "payload-a" },
    });
    let calls = 0;

    await expect(
      coordinator.execute({ key }, () => {
        calls += 1;
        throw Object.assign(new Error("temporarily unavailable"), { status: 503 });
      }),
    ).rejects.toThrow("temporarily unavailable");

    const retry = await coordinator.execute({ key }, () => {
      calls += 1;
      return "created";
    });

    expect(retry).toMatchObject({ outcome: "executed", response: "created" });
    expect(calls).toBe(2);
    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { idempotencyFailurePhase: "handler" },
        retryable: true,
      }),
    );
  });

  it.each([undefined, 60_000])(
    "makes a reserved audit failure retryable when ttlMs is %s",
    async (ttlMs) => {
      const auditFailure = Object.assign(new Error("audit unavailable"), {
        code: "AUDIT_UNAVAILABLE",
        status: 503,
      });
      let auditAvailable = false;
      const store = new InMemoryIdempotencyStore<string>();
      const fail = vi.spyOn(store, "fail");
      const coordinator = createIdempotencyCoordinator({
        store,
        auditSink: {
          recordIdempotency: (event) => {
            if (event.type === "idempotency.reserved" && !auditAvailable) {
              throw auditFailure;
            }
          },
        },
      });
      const key = deriveIdempotencyKey({
        namespace: "audit-recovery",
        source: { kind: "explicit", key: "key-1", fingerprint: "payload-a" },
      });
      const handler = vi.fn(() => "created");

      await expect(
        coordinator.execute(
          {
            key,
            ttlMs,
            metadata: { operation: "create" },
            isRetryable: () => {
              throw new Error("handler policy must not classify audit failures");
            },
          },
          handler,
        ),
      ).rejects.toBe(auditFailure);

      expect(handler).not.toHaveBeenCalled();
      expect(fail).toHaveBeenCalledWith({
        key,
        reservationId: "reservation-1",
        problem: {
          code: "AUDIT_UNAVAILABLE",
          status: 503,
          detail: "audit unavailable",
        },
        retryable: true,
        ttlMs,
        metadata: {
          operation: "create",
          idempotencyFailurePhase: "reserved-audit",
        },
      });

      auditAvailable = true;
      const recovered = await coordinator.execute({ key, ttlMs }, handler);

      expect(recovered).toMatchObject({ outcome: "executed", response: "created" });
      expect(handler).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps a failed-state write error as secondary evidence on the original audit failure", async () => {
    const auditFailure = new Error("audit unavailable");
    const failureRecordError = new InvalidIdempotencyKeyProblem("failure record unavailable");

    class FailureRecordStore<TResult> extends InMemoryIdempotencyStore<TResult> {
      override async fail(): Promise<never> {
        throw failureRecordError;
      }
    }

    const store = new FailureRecordStore<string>();
    const coordinator = createIdempotencyCoordinator({
      store,
      auditSink: {
        recordIdempotency: () => {
          throw auditFailure;
        },
      },
    });
    const key = deriveIdempotencyKey({
      namespace: "audit-recovery",
      source: { kind: "explicit", key: "key-1", fingerprint: "payload-a" },
    });
    const handler = vi.fn(() => "must-not-run");

    await expect(coordinator.execute({ key }, handler)).rejects.toBe(auditFailure);

    expect(handler).not.toHaveBeenCalled();
    expect(Object.getOwnPropertyDescriptor(auditFailure, "idempotencyFailureRecordError")).toEqual({
      configurable: true,
      enumerable: false,
      value: failureRecordError,
      writable: false,
    });
  });

  it("transitions the reservation when audit failure diagnostics have hostile getters", async () => {
    const auditFailure = new Error("audit unavailable");
    Object.defineProperty(auditFailure, "code", {
      get: () => {
        throw new Error("must not escape diagnostic extraction");
      },
    });
    let auditAvailable = false;
    const store = new InMemoryIdempotencyStore<string>();
    const fail = vi.spyOn(store, "fail");
    const coordinator = createIdempotencyCoordinator({
      store,
      auditSink: {
        recordIdempotency: () => {
          if (!auditAvailable) {
            throw auditFailure;
          }
        },
      },
    });
    const key = deriveIdempotencyKey({
      namespace: "audit-recovery",
      source: { kind: "explicit", key: "hostile-error", fingerprint: "payload-a" },
    });
    const handler = vi.fn(() => "created");

    await expect(coordinator.execute({ key }, handler)).rejects.toBe(auditFailure);

    expect(handler).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({
        problem: { code: "unknown", detail: "audit unavailable" },
        retryable: true,
      }),
    );

    auditAvailable = true;
    await expect(coordinator.execute({ key }, handler)).resolves.toMatchObject({
      outcome: "executed",
      response: "created",
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("transitions the reservation when failure metadata has hostile getters", async () => {
    class MetadataIsolatingStore<TResult> extends InMemoryIdempotencyStore<TResult> {
      override reserve(key: DerivedIdempotencyKey, options: IdempotencyReserveOptions = {}) {
        return super.reserve(key, { ...options, metadata: {} });
      }
    }

    const auditFailure = new Error("audit unavailable");
    let auditAvailable = false;
    const store = new MetadataIsolatingStore<string>();
    const fail = vi.spyOn(store, "fail");
    const coordinator = createIdempotencyCoordinator({
      store,
      auditSink: {
        recordIdempotency: () => {
          if (!auditAvailable) {
            throw auditFailure;
          }
        },
      },
    });
    const key = deriveIdempotencyKey({
      namespace: "audit-recovery",
      source: { kind: "explicit", key: "hostile-metadata", fingerprint: "payload-a" },
    });
    const metadata = Object.defineProperty({}, "payload", {
      enumerable: true,
      get: () => {
        throw new Error("must not escape metadata extraction");
      },
    });
    const handler = vi.fn(() => "created");

    await expect(coordinator.execute({ key, metadata }, handler)).rejects.toBe(auditFailure);

    expect(handler).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { idempotencyFailurePhase: "reserved-audit" },
        retryable: true,
      }),
    );

    auditAvailable = true;
    await expect(coordinator.execute({ key }, handler)).resolves.toMatchObject({
      outcome: "executed",
      response: "created",
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("preserves a non-extensible audit failure when failed-state recording also fails", async () => {
    const auditFailure = Object.freeze(new Error("audit unavailable"));
    const failureRecordError = new InvalidIdempotencyKeyProblem("failure record unavailable");

    class FailureRecordStore<TResult> extends InMemoryIdempotencyStore<TResult> {
      override async fail(): Promise<never> {
        throw failureRecordError;
      }
    }

    const coordinator = createIdempotencyCoordinator({
      store: new FailureRecordStore<string>(),
      auditSink: {
        recordIdempotency: () => {
          throw auditFailure;
        },
      },
    });
    const key = deriveIdempotencyKey({
      namespace: "audit-recovery",
      source: { kind: "explicit", key: "frozen-error", fingerprint: "payload-a" },
    });

    await expect(coordinator.execute({ key }, () => "must-not-run")).rejects.toBe(auditFailure);
  });

  it("prevents handler re-execution when commit fails before persistence", async () => {
    const commitFailure = new InvalidIdempotencyKeyProblem("commit failed");

    class CommitFailureStore<TResult> extends InMemoryIdempotencyStore<TResult> {
      private commitAvailable = false;

      override async commit(options: IdempotencyCommitOptions<TResult>) {
        if (!this.commitAvailable) {
          this.commitAvailable = true;
          throw commitFailure;
        }
        return super.commit(options);
      }
    }

    const store = new CommitFailureStore<string>();
    const fail = vi.spyOn(store, "fail");
    const coordinator = createIdempotencyCoordinator({ store });
    const key = deriveIdempotencyKey({
      namespace: "commit",
      source: { kind: "explicit", key: "key-1", fingerprint: "payload-a" },
    });
    const handler = vi.fn(() => "created");

    await expect(
      coordinator.execute(
        {
          key,
          isRetryable: () => {
            throw new Error("handler policy must not classify commit failures");
          },
        },
        handler,
      ),
    ).rejects.toBe(commitFailure);

    expect(fail).toHaveBeenCalledWith({
      key,
      reservationId: "reservation-1",
      problem: {
        code: "idempotency-core/invalid-key",
        status: 400,
        detail: "Invalid idempotency key: commit failed",
      },
      retryable: false,
      ttlMs: undefined,
      metadata: { idempotencyFailurePhase: "commit" },
    });

    const retry = coordinator.execute({ key }, handler);
    await expect(retry).rejects.toBeInstanceOf(IdempotencyExecutionIndeterminateProblem);
    await expect(retry).rejects.toMatchObject({
      code: "idempotency-core/execution-indeterminate",
      category: "Conflict",
      extensions: expect.objectContaining({
        key: "key-1",
        namespace: "commit",
        failedAt: expect.any(String),
      }),
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("records a non-retryable commit failure even when the handler mutates request metadata", async () => {
    const commitFailure = new InvalidIdempotencyKeyProblem("commit failed");

    class CommitFailureStore<TResult> extends InMemoryIdempotencyStore<TResult> {
      override async commit(): Promise<never> {
        throw commitFailure;
      }
    }

    const store = new CommitFailureStore<string>();
    const fail = vi.spyOn(store, "fail");
    const coordinator = createIdempotencyCoordinator({ store });
    const key = deriveIdempotencyKey({
      namespace: "commit",
      source: { kind: "explicit", key: "mutated-metadata", fingerprint: "payload-a" },
    });
    const metadata: Record<string, unknown> = { operation: "create" };
    const handler = vi.fn(() => {
      metadata.unpersistable = Buffer.from("not snapshot-safe");
      return "created";
    });

    await expect(coordinator.execute({ key, metadata }, handler)).rejects.toBe(commitFailure);

    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({
        retryable: false,
        metadata: { operation: "create", idempotencyFailurePhase: "commit" },
      }),
    );

    await expect(coordinator.execute({ key }, handler)).rejects.toBeInstanceOf(
      IdempotencyExecutionIndeterminateProblem,
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("records a non-retryable commit failure when the audit sink pollutes reserved metadata", async () => {
    const commitFailure = new InvalidIdempotencyKeyProblem("commit failed");

    class CommitFailureStore<TResult> extends InMemoryIdempotencyStore<TResult> {
      override async commit(): Promise<never> {
        throw commitFailure;
      }
    }

    const store = new CommitFailureStore<string>();
    const fail = vi.spyOn(store, "fail");
    const coordinator = createIdempotencyCoordinator({
      store,
      auditSink: {
        recordIdempotency: (event) => {
          const metadata = event.metadata as Record<string, unknown> | undefined;
          if (event.type !== "idempotency.reserved" || metadata === undefined) {
            return;
          }
          const detail = metadata.details as { shared?: string } | undefined;
          if (detail !== undefined) {
            detail.shared = "polluted-by-audit";
          }
          metadata.unpersistable = Buffer.from("not snapshot-safe");
        },
      },
    });
    const key = deriveIdempotencyKey({
      namespace: "commit",
      source: { kind: "explicit", key: "polluted-metadata", fingerprint: "payload-a" },
    });
    const handler = vi.fn(() => "created");

    await expect(
      coordinator.execute(
        { key, metadata: { operation: "create", details: { shared: "safe" } } },
        handler,
      ),
    ).rejects.toBe(commitFailure);

    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({
        retryable: false,
        metadata: {
          operation: "create",
          details: { shared: "safe" },
          idempotencyFailurePhase: "commit",
        },
      }),
    );

    await expect(coordinator.execute({ key }, handler)).rejects.toBeInstanceOf(
      IdempotencyExecutionIndeterminateProblem,
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("replays a durable response when commit persists before rejecting", async () => {
    const commitFailure = new InvalidIdempotencyKeyProblem("commit acknowledgement failed");

    class PersistedCommitFailureStore<TResult> extends InMemoryIdempotencyStore<TResult> {
      override async commit(
        options: IdempotencyCommitOptions<TResult>,
      ): Promise<IdempotencyCompletedRecord<TResult>> {
        await super.commit(options);
        throw commitFailure;
      }
    }

    const store = new PersistedCommitFailureStore<string>();
    const coordinator = createIdempotencyCoordinator({ store });
    const key = deriveIdempotencyKey({
      namespace: "commit",
      source: { kind: "explicit", key: "persisted", fingerprint: "payload-a" },
    });
    const handler = vi.fn(() => "created");

    await expect(coordinator.execute({ key }, handler)).rejects.toBe(commitFailure);

    expect(
      Object.getOwnPropertyDescriptor(commitFailure, "idempotencyFailureRecordError")?.value,
    ).toBeInstanceOf(IdempotencyReservationStateProblem);
    await expect(coordinator.execute({ key }, handler)).resolves.toMatchObject({
      outcome: "replayed",
      response: "created",
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
