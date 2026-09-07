import { describe, expect, it } from "vitest";

import {
  CreditOperationsValidationProblem,
  executeCreditOperationsAction,
  loadCreditOperations,
  type CreditOperationsAction,
  type CreditOperationsActionRequest,
  type CreditOperationsReadyState,
} from "@croco/admin-core";
import {
  CreditLedgerService,
  creditAccountId,
  creditAmount,
  InMemoryCreditLedgerStore,
} from "@croco/credits-core";

import {
  CreditOperationsService,
  createActionRequest,
  createExecutor,
  createFixtureSnapshot,
} from "../creditOperations";
import { creditOperationsActionCommandSchema } from "../controllers/adminSchemas";

const now = new Date("2026-07-30T00:00:00.000Z");
const permissions = ["credits:read", "credits:write", "credits:refund", "credits:release"];

describe("generated credit operations smoke", () => {
  it("derives executable actions on the server instead of trusting client action metadata", async () => {
    const service = new CreditOperationsService();
    const snapshot = await service.snapshot("authorization-tenant");
    const state = await loadCreditOperations({
      grantedPermissions: permissions,
      source: {
        requiredPermissions: ["credits:read"],
        load: async () => ({ kind: "ready", snapshot }),
      },
      tenantId: snapshot.tenantId,
    });
    if (state.kind !== "ready") {
      throw new Error(`Expected ready credit operations state, received ${state.kind}`);
    }
    const grant = requireAction(state, "grant");

    const execution = service.execute(
      { kind: "grant", targetId: "client-forged-target" },
      createActionRequest(grant, {
        actorId: "smoke-operator",
        idempotencyKey: "forged-action",
        reason: "Verify server-derived authorization",
      }),
    );

    await expect(execution).rejects.toThrow(CreditOperationsValidationProblem);
    await expect(execution).rejects.toMatchObject({
      code: "admin-core/credit-operations-validation-failed",
    });
  });

  it("rejects command fields that do not match the discriminated input kind", () => {
    const common = {
      accountId: "account-1",
      actorId: "operator-1",
      auditReason: "Verify schema discrimination",
      expectedPosition: 0,
      idempotencyKey: "schema-discrimination",
      referenceId: "audit-1",
      referenceType: "admin-credit-operation",
      targetId: "account-1",
      tenantId: "tenant-1",
    };

    expect(
      creditOperationsActionCommandSchema.safeParse({
        ...common,
        actionKind: "refund",
        amount: "1",
        inputKind: "grant",
      }).success,
    ).toBe(false);
    expect(
      creditOperationsActionCommandSchema.safeParse({
        ...common,
        actionKind: "release-reservation",
        amount: "1",
        inputKind: "release-reservation",
        reservationId: "reservation-1",
      }).success,
    ).toBe(false);
  });

  it("masks reference values and reports fully reserved grant lots", async () => {
    const service = new CreditLedgerService({
      clock: () => now,
      store: new InMemoryCreditLedgerStore(),
      eventDelivery: "development",
    });
    const opened = await service.openAccount({
      idempotencyKey: "masked-account",
      reference: { id: "tenant-secret", type: "tenant-credit-account" },
      tenantId: "masked-tenant",
      walletKey: "usage",
    });
    await service.grantCredits({
      accountId: opened.account.id,
      amount: creditAmount("5"),
      idempotencyKey: "masked-grant",
      reference: { id: "sensitive-reference", type: "support-case" },
      source: "sensitive-source",
    });
    await service.reserveCredits({
      accountId: opened.account.id,
      amount: creditAmount("5"),
      idempotencyKey: "masked-reservation",
      reference: { id: "sensitive-request", type: "usage-request" },
    });

    const snapshot = await createFixtureSnapshot(service, "masked-tenant", now);
    const grantLot = snapshot.grantLots.find((lot) => lot.transactionId !== "");

    expect(grantLot).toMatchObject({
      remaining: "0",
      source: { visibility: "masked" },
      status: "reserved",
    });
    expect(grantLot?.source).not.toHaveProperty("value");
    expect(JSON.stringify(snapshot)).not.toContain("sensitive-source");
    expect(
      snapshot.transactions.every((transaction) => transaction.reference.value === undefined),
    ).toBe(true);
  });

  it("appends an audited transaction without rewriting fixture history", async () => {
    const { executor, grant, ready, request, service } = await createActionFixture("smoke-grant");
    const positions = ready.snapshot.transactions.map((transaction) => transaction.position);

    expect(positions).toEqual(positions.map((_, index) => index + 1));
    expect(positions[positions.length - 1]).toBe(ready.snapshot.balance.ledgerPosition);
    expect(ready.snapshot.transactions.map((transaction) => transaction.kind)).toEqual(
      expect.arrayContaining([
        "grant",
        "reserve",
        "commit",
        "release",
        "expire",
        "consume",
        "refund",
      ]),
    );
    expect(
      ready.snapshot.transactions.find((transaction) => transaction.kind === "consume")?.allocations
        .length,
    ).toBeGreaterThan(0);
    const appended = await executeCreditOperationsAction({
      action: grant,
      executor,
      grantedPermissions: permissions,
      now,
      request,
    });
    expect(appended).toMatchObject({ kind: "succeeded", replayed: false });
    if (appended.kind !== "succeeded") {
      throw new Error("Generated grant did not append a transaction");
    }
    const afterAppend = await service.getHistory(creditAccountId(ready.snapshot.accountId));
    expect(
      afterAppend.transactions
        .slice(0, ready.snapshot.transactions.length)
        .map((transaction) => transaction.id),
    ).toEqual(ready.snapshot.transactions.map((transaction) => transaction.id));
    const appendedTransaction = afterAppend.transactions.find(
      (transaction) => transaction.id === appended.transactionIds[0],
    );
    const auditReference = new URLSearchParams(appendedTransaction?.reference.id);
    expect(auditReference.get("actorId")).toBe("smoke-operator");
    expect(auditReference.get("reason")).toBe("Verify generated admin recovery");
  });

  it("replays an identical idempotent append without advancing the ledger", async () => {
    const { executor, grant, ready, request, service } = await createActionFixture("replay-grant");
    const appended = await executeCreditOperationsAction({
      action: grant,
      executor,
      grantedPermissions: permissions,
      now,
      request,
    });
    if (appended.kind !== "succeeded") {
      throw new Error("Generated grant did not append a transaction");
    }
    const replayed = await executeCreditOperationsAction({
      action: grant,
      executor,
      grantedPermissions: permissions,
      now,
      request,
    });
    expect(replayed).toMatchObject({ kind: "succeeded", replayed: true });
    expect((await service.getHistory(creditAccountId(ready.snapshot.accountId))).position).toBe(
      appended.ledgerPosition,
    );
  });

  it("returns duplicate-conflict recovery for semantic idempotency reuse", async () => {
    const { executor, grant, request } = await createActionFixture("conflicting-grant");
    await executeCreditOperationsAction({
      action: grant,
      executor,
      grantedPermissions: permissions,
      now,
      request,
    });
    if (request.input.kind !== "grant") {
      throw new Error("Generated grant action did not create grant input");
    }
    const conflictingRequest: CreditOperationsActionRequest = {
      ...request,
      input: { ...request.input, amount: "6" },
    };
    await expect(
      executeCreditOperationsAction({
        action: grant,
        executor,
        grantedPermissions: permissions,
        now,
        request: conflictingRequest,
      }),
    ).resolves.toMatchObject({
      kind: "problem",
      problem: { code: "credits-core/duplicate-conflict" },
      recovery: "change-input",
    });
  });

  it("returns stale-ledger recovery after the current position advances", async () => {
    const { executor, grant, ready, service } = await createActionFixture("stale-fixture");
    const refreshed = await loadReadyState(service);
    const staleGrant = requireAction(refreshed, "grant");
    await service.grantCredits({
      accountId: creditAccountId(refreshed.snapshot.accountId),
      amount: creditAmount("1"),
      expectedPosition: refreshed.snapshot.balance.ledgerPosition,
      idempotencyKey: "advance-ledger",
      reference: { id: "advance-ledger", type: "smoke" },
      source: "smoke",
    });
    await expect(
      executeCreditOperationsAction({
        action: staleGrant,
        executor,
        grantedPermissions: permissions,
        now,
        request: createActionRequest(staleGrant, {
          actorId: "smoke-operator",
          idempotencyKey: "stale-grant",
          reason: "Verify stale recovery",
        }),
      }),
    ).resolves.toMatchObject({
      kind: "problem",
      problem: { code: "credits-core/stale-ledger-position" },
      recovery: "refresh-ledger",
    });
    expect(grant.ledgerPosition).toBe(ready.snapshot.balance.ledgerPosition);
  });

  it("reports committed event-publication failures with durable ledger evidence", async () => {
    const eventStore = new InMemoryCreditLedgerStore();
    const fixtureService = new CreditLedgerService({
      clock: () => now,
      store: eventStore,
      eventDelivery: "development",
    });
    const eventReady = await loadReadyState(fixtureService, "event-tenant");
    const eventGrant = requireAction(eventReady, "grant");
    const eventService = new CreditLedgerService({
      clock: () => now,
      eventPublisher: {
        onAfterCommit() {
          throw new Error("event publisher unavailable");
        },
        publishIdempotently: () => Promise.reject(new Error("event publisher unavailable")),
      },
      store: eventStore,
      eventDelivery: "development",
    });
    await expect(
      executeCreditOperationsAction({
        action: eventGrant,
        executor: createExecutor(eventService),
        grantedPermissions: permissions,
        now,
        request: createActionRequest(eventGrant, {
          actorId: "smoke-operator",
          idempotencyKey: "event-grant",
          reason: "Verify committed event recovery",
        }),
      }),
    ).resolves.toMatchObject({
      kind: "problem",
      ledgerCommitted: true,
      problem: { code: "credits-core/event-publication-failed" },
      recovery: "retry-event-publication",
    });
    expect(
      (await eventService.getHistory(creditAccountId(eventReady.snapshot.accountId))).position,
    ).toBe(eventReady.snapshot.balance.ledgerPosition + 1);
  });
});

async function createActionFixture(idempotencyKey: string) {
  const service = new CreditLedgerService({
    clock: () => now,
    store: new InMemoryCreditLedgerStore(),
    eventDelivery: "development",
  });
  const ready = await loadReadyState(service, `tenant-${idempotencyKey}`);
  const grant = requireAction(ready, "grant");
  return {
    executor: createExecutor(service),
    grant,
    ready,
    request: createActionRequest(grant, {
      actorId: "smoke-operator",
      idempotencyKey,
      reason: "Verify generated admin recovery",
    }),
    service,
  };
}

async function loadReadyState(
  service: CreditLedgerService,
  tenantId = "smoke-tenant",
): Promise<CreditOperationsReadyState> {
  const snapshot = await createFixtureSnapshot(service, tenantId, now);
  const state = await loadCreditOperations({
    grantedPermissions: permissions,
    source: {
      requiredPermissions: ["credits:read"],
      load: async () => ({ kind: "ready", snapshot }),
    },
    tenantId,
  });
  if (state.kind !== "ready") {
    throw new Error(`Expected ready credit operations state, received ${state.kind}`);
  }
  return state;
}

function requireAction(
  state: CreditOperationsReadyState,
  kind: CreditOperationsAction["kind"],
): CreditOperationsAction {
  const action = state.actions.find((candidate) => candidate.kind === kind);
  if (action === undefined) {
    throw new Error(`Missing generated ${kind} action`);
  }
  return action;
}
