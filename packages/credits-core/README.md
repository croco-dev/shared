# @croco/credits-core

Provider-neutral append-only credit ledger for SaaS usage credits. Balances are projections of
immutable transactions and allocations rather than mutable fields.

## Install

```bash
pnpm add @croco/credits-core
```

## Amounts and identifiers

Credit amounts are canonical base-10 strings with at most 18 fractional digits. Construct command
amounts with `creditAmount()`; JavaScript numbers and exponent notation are intentionally rejected so
binary floating-point conversion cannot enter the ledger.

```ts
import { creditAmount } from "@croco/credits-core";

const tokens = creditAmount("1250.500000000000000001");
```

`CreditAccountId`, `CreditTransactionId`, and `CreditReservationId` are branded strings. Adapters may
restore persisted identifiers with `creditAccountId()`, `creditTransactionId()`, and
`creditReservationId()`.

## Usage

```ts
import { CreditLedgerService, InMemoryCreditLedgerStore, creditAmount } from "@croco/credits-core";

const credits = new CreditLedgerService({
  store: new InMemoryCreditLedgerStore(),
  eventDelivery: "development",
  eventPublisher,
});

const opened = await credits.openAccount({
  tenantId: "tenant-123",
  walletKey: "ai-usage",
  idempotencyKey: "account:tenant-123:ai-usage",
  reference: { type: "tenant-wallet", id: "tenant-123:ai-usage" },
});

await credits.grantCredits({
  accountId: opened.account.id,
  amount: creditAmount("1000"),
  expiresAt: new Date("2027-01-01T00:00:00.000Z"),
  source: "promotion-2026",
  meterKeys: ["llm.tokens"],
  idempotencyKey: "grant:promotion-2026:tenant-123",
  reference: { type: "promotion-grant", id: "promotion-2026:tenant-123" },
});

const reservation = await credits.reserveCredits({
  accountId: opened.account.id,
  amount: creditAmount("100"),
  meterKey: "llm.tokens",
  idempotencyKey: "request:req-123:reserve",
  reference: { type: "usage-request", id: "req-123" },
});

if (reservation.reservation) {
  await credits.commitCredits({
    accountId: opened.account.id,
    reservationId: reservation.reservation.id,
    amount: creditAmount("72.5"),
    idempotencyKey: "request:req-123:commit",
    reference: { type: "usage-request", id: "req-123" },
  });
}
```

A partial commit appends a `commit` transaction for actual usage and a `release` transaction for the
remainder in one atomic command. Direct consumption, full release, linked refunds, compensating
credit/debit adjustments, and bounded expiry batches use the same command contract.

## Ledger invariants

- Transactions and allocation records are append-only. There is no balance setter.
- Every command requires an idempotency key scoped to its tenant ledger and an immutable semantic
  reference.
- Replaying the same semantic command returns its original identifiers and result without another
  balance movement. Reusing the key for different input raises
  `CreditDuplicateConflictProblem`.
- Store implementations serialize commands per account, check `expectedPosition` when provided, and
  atomically persist all transactions produced by one command.
- Grant allocation order is earliest expiry, then ledger position, then transaction ID. Restricted or
  expired lots cannot fund ineligible usage.
- Refunds append a new credit lot linked to the original `consume` or `commit` transaction. The
  refunded lot keeps the earliest expiry among the original allocations it restores, so a refund
  cannot extend promotional credit lifetime. Original history is never rewritten.
- `getBalance(accountId, position)` and `getHistory(accountId, { atPosition })` read the same immutable
  prefix. A future or invalid position raises `StaleLedgerPositionProblem`.

`available` is the transaction projection at a ledger position. A grant whose wall-clock expiry has
passed remains in that projection until `expireCredits()` appends its expiry transaction, but it is
immediately ineligible for reserve or consume allocation.

## Expiry pagination

`expireCredits()` handles at most 100 eligible lots per call and returns an opaque `nextCursor` when
more work remains. Each page needs a new idempotency key; replaying a page returns the same page
result.

```ts
let cursor;
do {
  const page = await credits.expireCredits({
    accountId,
    asOf: new Date(),
    limit: 50,
    cursor,
    idempotencyKey: `expiry:2026-07-26:${cursor ?? "first"}`,
    reference: { type: "expiry-run", id: "2026-07-26" },
  });
  cursor = page.nextCursor;
} while (cursor);
```

## Events and adapter contract

`CreditLedgerStore.execute()` must atomically persist every transaction-producing command and its
`CreditLedgerCommittedEvent` intent. `CreditLedgerService` schedules the stable event identity through
`onAfterCommit(publish)` when an ambient transaction exists and otherwise calls
`publishIdempotently()` after the store commit. The scheduled callback acquires a claim and invokes `publishIdempotently()` only after commit.
Publication acknowledgement marks the stored intent as published only while its claim token is current; a crash before acknowledgement leaves it available to command replay or
`publishPendingEvents()` without applying the balance movement twice.

If the ambient transaction cannot report after-commit outcomes, the service leaves the intent pending
instead of publishing before commit. A command whose ledger mutation already committed also remains
successful when immediate publication fails; retry the idempotent command or call
`publishPendingEvents()` to deliver the retained intent.

Event intents carry their tenant identity, and stores resolve a command-specific pending intent with
`getPendingEventIntent(tenantId, idempotencyKey)`. Event IDs bind both values so equal client-generated
keys in independent tenant ledgers cannot alias during publication.

The default service mode is `durable` and fails fast unless the store reports persistent event-intent
capability. `InMemoryCreditLedgerStore` is intentionally available only through the explicit
`eventDelivery: "development"` mode. Its intent queue is volatile and cannot be used as production
delivery evidence. Publishers must deduplicate by `event.eventId` because a crash after transport
acceptance but before acknowledgement can produce an at-least-once retry.

`publishPendingEvents(limit)` atomically claims at most `limit` intents and starts their publications
concurrently. Immediate publication and replay use the same claim path. Failed publications release their
claim for retry; abandoned claims become eligible after `eventClaimLeaseMs` (default 60 seconds). Set the
lease longer than the publisher's maximum transport timeout. Exclusivity lasts for the lease: a paused or
slow publisher can overlap recovery after expiry, so publisher deduplication remains required. A stale
worker cannot acknowledge or release the replacement worker's claim. Polling must run outside an ambient
transaction so every claim commits before external dispatch.

Custom stores must implement `claimPendingEventIntents`, token-fenced `markEventIntentPublished`, and
`releaseEventIntentClaim` using an authoritative store clock. Custom publishers must replace
`publishIdempotentlyAfterCommit(event, onPublished)` with `onAfterCommit(publish)`, registering the supplied
callback without sending the event themselves. The callback must run only after a successful commit and
outside the completed transaction context.

Adapters must pass the exported conformance suite:

```ts
import { createCreditLedgerStoreConformanceSuite } from "@croco/credits-core";

const suite = createCreditLedgerStoreConformanceSuite({
  storeName: "my-credit-store",
  createStore: () => createStore(),
});

for (const testCase of suite.cases) {
  test(testCase.name, testCase.run);
}
```

The suite covers a semantic idempotency conflict matrix, concurrent overdraw and competing settlement
prevention, atomic partial settlement and failure paths, restricted allocation, historical
projections, deterministic bounded expiry, linked expiry-preserving refunds, and projection evidence.

`InMemoryCreditLedgerStore` is a deterministic reference adapter: historical balance projection and
linked refund lookup scan account history. Production adapters should persist periodic balance
checkpoints and index `relatedTransactionId`, while preserving the same append-only transaction and
conformance contracts.

## Verification

```bash
pnpm --filter @croco/credits-core test
pnpm --filter @croco/credits-core typecheck
pnpm --filter @croco/credits-core build
pnpm public-api:check
pnpm problem-registry:check
pnpm docs:api:check
pnpm docs:catalog:check
```
