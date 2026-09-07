# @croco/credits-drizzle

PostgreSQL/Drizzle persistence for the append-only `@croco/credits-core` ledger.

```bash
pnpm add @croco/credits-core @croco/credits-drizzle @croco/tx-core @croco/tx-drizzle drizzle-orm pg
```

## Setup

Run the exported migration once, then construct the store with the same Drizzle client used by the
application:

```ts
import { CreditLedgerService } from "@croco/credits-core";
import { createCreditsSchema, DrizzleCreditLedgerStore } from "@croco/credits-drizzle";
import { TxManager } from "@croco/tx-core";
import { createDrizzleTxAdapter } from "@croco/tx-drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

await createCreditsSchema(db);
const txManager = new TxManager(createDrizzleTxAdapter(db));

const credits = new CreditLedgerService({
  store: new DrizzleCreditLedgerStore(db, txManager),
  eventPublisher: {
    onAfterCommit(publish) {
      txManager.onAfterCommit(publish);
    },
    publishIdempotently: publishToBrokerIdempotently,
  },
});
```

`createCreditsSchema` is an idempotent bootstrap for the current schema and `dropCreditsSchema` exists for
test teardown. Production deployments should invoke versioned migrations through the application's normal
migration runner.

## Transaction and concurrency contract

Each command joins the injected `TxManager` transaction or opens one when no transaction is active. The
adapter:

- takes a transaction-scoped advisory lock for the tenant and idempotency key;
- locks the account row before reading balances, grant lots, or reservations;
- appends ledger transactions and allocations before atomically updating the account projection;
- stores the committed command result with its semantic fingerprint;
- inserts a stable `credit_ledger_event_intents` row in the same transaction as the ledger mutation and
  idempotency record;
- lets `CreditLedgerService` register idempotent publication against the same outer transaction, or
  publishes only after the adapter-owned transaction commits.

Use `txManager.runWithOutcome()` when an outer transaction must schedule publication. A plain
`txManager.run()` cannot report after-commit failures, so the service completes the committed command
with its event intent still pending; retry the command or call `publishPendingEvents()` after the outer
transaction commits.

Pending publication uses short PostgreSQL transactions with `FOR UPDATE SKIP LOCKED` to claim disjoint
batches across workers. Claims use a random token and database-clock expiry; acknowledgement and release
succeed only for the current unexpired owner. Claiming inside an active transaction fails explicitly.
Publication runs after commit and outside the claim transaction. `publishPendingEvents()` uses a
60-second lease by default; configure a lease longer than the publisher's transport timeout. A crashed
worker's claims become available after expiry. Broker idempotency remains required for delivery beyond
lease expiry or a crash between broker acceptance and acknowledgement. `listPendingEventIntents()` is
a diagnostic read and does not acquire ownership.

The schema bootstrap adds nullable `claim_token` and `claim_expires_at` columns to existing installations
without changing event IDs or publication state. Stop older publishers before enabling claimed delivery.

### Existing-row migration

`createCreditsSchema` backfills an unpublished intent for every existing idempotency record whose stored
result contains transactions. Those rows have unknown historical delivery state, so the safe migration is
operator-controlled at-least-once recovery: first reconcile downstream consumers by the immutable
`transactionIds` in each event because previously published events had unrelated random event IDs. Then
deploy an idempotent publisher, run `publishPendingEvents()` in bounded batches until it returns `0`, and
retain normal downstream deduplication by the new stable event ID. Do not publish legacy unknown-state
rows to a consumer that cannot semantically deduplicate transaction IDs, and do not mark them published
based only on their age or ledger position. Rerun the idempotent migration after all legacy writers have
stopped. The current adapter also repairs a missing intent atomically whenever its idempotency key is
replayed, closing gaps created during a rolling deployment without repeating the balance movement.

The same migration derives `tenant_id` from each existing record's account (or its stored account result),
then replaces the global key and event-intent constraints with `(tenant_id, key)` constraints. It fails
instead of guessing when a legacy row has no recoverable tenant. Stop legacy writers before this constraint
cutover; after it completes, the same client-generated key is independent across tenant ledgers.

The supported isolation level is PostgreSQL `READ COMMITTED` plus explicit account/lot/reservation row
locking. Writes to one account are serialized, so concurrent reservations cannot spend the same grant
availability. Account IDs, transaction IDs, reservation IDs, tenant/wallet identities, ledger positions,
and tenant-scoped idempotency keys have database uniqueness constraints. Composite foreign keys reject
cross-account reservation, refund, lot, and allocation references.

## Amounts and ordering

Amounts use arbitrary-precision PostgreSQL `numeric` values and are mapped to the canonical decimal-string
contract from `credits-core` (up to 18 fractional digits, no JavaScript floating point). Ledger positions
are monotonically assigned while the account row is locked; timestamps never determine history order.

Expiry uses an indexed `(account, expiresAt, position, grantTransactionId)` keyset cursor and retrieves at
most `limit + 1` lots. Batches are bounded to 100 and resumable without loading the whole lot table.
Consumption also locks eligible lots in bounded pages of 100 until the requested amount is satisfied.

Refunds preserve the earliest original allocation expiry that is strictly later than the refund's
`occurredAt`. If no restored allocation has a future expiry, the new refund lot has no expiry.
An expiry equal to `occurredAt` has already elapsed. This adapter policy keeps newly refunded credits
spendable; it differs from the in-memory store's unconditional earliest-expiry policy. Refunds retain
the original consumption's meter restriction and allocation lineage. Existing ledger history and
previously persisted refund lots are not rewritten.

## Diagnostics

Domain failures preserve the typed Problems from `credits-core`. Unexpected driver or SQL failures become
`CreditLedgerPersistenceProblem`; its public detail contains only the operation name and never SQL,
connection strings, or credentials.

## Verification

```bash
pnpm --filter @croco/credits-drizzle test
CREDITS_POSTGRES_URL=postgresql://... pnpm --filter @croco/credits-drizzle test:postgres
pnpm --filter @croco/credits-drizzle typecheck
pnpm --filter @croco/credits-drizzle build
```

The PostgreSQL suite runs every exported `credits-core` conformance case, including reservation races,
idempotency conflicts, deterministic expiry, historical balance reads, rollback, and tenant isolation.
