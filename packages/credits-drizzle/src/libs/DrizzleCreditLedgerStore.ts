import { randomUUID } from "node:crypto";
import {
  addCreditAmounts,
  addSignedCreditAmounts,
  compareCreditAmounts,
  creditAmount,
  CreditAccountMismatchProblem,
  CreditAccountNotFoundProblem,
  CreditDuplicateConflictProblem,
  CreditLedgerStore,
  createCreditLedgerEventIntent,
  createCreditIdempotencyIdentity,
  CreditRefundMismatchProblem,
  CreditReservationMismatchProblem,
  CreditTransactionNotFoundProblem,
  ExpiredGrantProblem,
  InsufficientCreditsProblem,
  InvalidCreditCommandProblem,
  StaleLedgerPositionProblem,
  subtractCreditAmounts,
  toSignedCreditAmount,
  ZERO_CREDIT_AMOUNT,
  ZERO_CREDIT_SIGNED_AMOUNT,
} from "@croco/credits-core";
import { Problem } from "@croco/problems-core";
import type { TxManager } from "@croco/tx-core";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  ClaimedCreditLedgerEventIntent,
  AdjustCreditsCommand,
  CommitCreditsCommand,
  CreditAccount,
  CreditAccountId,
  CreditAllocation,
  CreditAmount,
  CreditBalance,
  CreditCommandResult,
  CreditExpiryCursor,
  CreditGrantTerms,
  CreditHistoryPage,
  CreditLedgerCommand,
  CreditLedgerEventIntent,
  CreditReservation,
  CreditReservationId,
  CreditSignedAmount,
  CreditTransaction,
  CreditTransactionId,
  ExpireCreditsCommand,
  OpenCreditAccountCommand,
  RefundCreditsCommand,
  ReleaseCreditsCommand,
  ReserveCreditsCommand,
} from "@croco/credits-core";
import { CreditLedgerPersistenceProblem } from "./problems";
import {
  creditAccounts,
  creditAllocations,
  creditGrantLots,
  creditIdempotencyRecords,
  creditLedgerEventIntents,
  creditReservationAllocations,
  creditReservations,
  creditTransactions,
} from "./schema";
import type {
  CreditAccountRow,
  CreditGrantLotRow,
  CreditReservationRow,
  CreditTransactionRow,
} from "./schema";

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

export type DrizzleCreditClient = NodePgDatabase<typeof schema>;
type DrizzleCreditTransaction = Parameters<Parameters<DrizzleCreditClient["transaction"]>[0]>[0];
export type DrizzleCreditTxManager = Pick<TxManager<DrizzleCreditTransaction>, "getClient" | "run">;

type MutableAccount = {
  id: CreditAccountId;
  tenantId: string;
  walletKey?: string;
  openedAt: Date;
  position: number;
  available: CreditAmount;
  reserved: CreditAmount;
  consumed: CreditAmount;
  expired: CreditAmount;
  lifetimeGranted: CreditAmount;
  netAdjusted: CreditSignedAmount;
};

type MutableLot = {
  grantTransactionId: CreditTransactionId;
  accountId: CreditAccountId;
  position: number;
  createdAt: Date;
  expiresAt?: Date;
  source?: string;
  meterKeys?: readonly string[];
  available: CreditAmount;
};

type StoredResult = Omit<CreditCommandResult, "account" | "transactions" | "reservation"> & {
  readonly account: Omit<CreditAccount, "openedAt"> & { readonly openedAt: string };
  readonly transactions: readonly (Omit<CreditTransaction, "occurredAt" | "grant"> & {
    readonly occurredAt: string;
    readonly grant?: Omit<CreditGrantTerms, "expiresAt"> & { readonly expiresAt?: string };
  })[];
  readonly reservation?: Omit<CreditReservation, "createdAt" | "settledAt"> & {
    readonly createdAt: string;
    readonly settledAt?: string;
  };
};

function amount(value: string): CreditAmount {
  const [integer, fraction] = value.split(".");
  const normalizedFraction = fraction?.replace(/0+$/, "");
  return `${integer}${normalizedFraction ? `.${normalizedFraction}` : ""}` as CreditAmount;
}

function signedAmount(value: string): CreditSignedAmount {
  return amount(value) as unknown as CreditSignedAmount;
}

function stableSerialize(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function semanticCommand(command: CreditLedgerCommand): unknown {
  switch (command.operation) {
    case "open": {
      const { accountId: _accountId, occurredAt: _occurredAt, ...semantic } = command;
      return semantic;
    }
    case "grant":
    case "reserve":
    case "consume":
    case "refund":
    case "adjust":
    case "release": {
      const { transactionId: _transactionId, occurredAt: _occurredAt, ...semantic } = command;
      return semantic;
    }
    case "commit": {
      const {
        commitTransactionId: _commitTransactionId,
        releaseTransactionId: _releaseTransactionId,
        occurredAt: _occurredAt,
        ...semantic
      } = command;
      return semantic;
    }
    case "expire": {
      const { transactionIds: _transactionIds, occurredAt: _occurredAt, ...semantic } = command;
      return semantic;
    }
  }
}

function candidateTransactionIds(command: CreditLedgerCommand): readonly CreditTransactionId[] {
  if (command.operation === "commit") {
    return [command.commitTransactionId, command.releaseTransactionId];
  }
  if (command.operation === "expire") return command.transactionIds;
  return "transactionId" in command ? [command.transactionId] : [];
}

function cloneGrant(grant: CreditGrantTerms | undefined): CreditGrantTerms | undefined {
  if (!grant) return undefined;
  return {
    ...grant,
    expiresAt: grant.expiresAt ? new Date(grant.expiresAt) : undefined,
    meterKeys: grant.meterKeys ? [...grant.meterKeys] : undefined,
  };
}

function deserializeResult(value: unknown): CreditCommandResult {
  const stored = value as StoredResult;
  return {
    ...stored,
    account: {
      ...stored.account,
      openedAt: new Date(stored.account.openedAt),
    },
    transactions: stored.transactions.map((transaction) => ({
      ...transaction,
      occurredAt: new Date(transaction.occurredAt),
      grant: transaction.grant
        ? {
            ...transaction.grant,
            expiresAt: transaction.grant.expiresAt
              ? new Date(transaction.grant.expiresAt)
              : undefined,
          }
        : undefined,
    })),
    reservation: stored.reservation
      ? {
          ...stored.reservation,
          createdAt: new Date(stored.reservation.createdAt),
          settledAt: stored.reservation.settledAt
            ? new Date(stored.reservation.settledAt)
            : undefined,
        }
      : undefined,
    replayed: true,
  };
}

function mapAccount(row: CreditAccountRow): MutableAccount {
  return {
    id: row.id as CreditAccountId,
    tenantId: row.tenantId,
    walletKey: row.walletKey ?? undefined,
    openedAt: new Date(row.openedAt),
    position: row.position,
    available: amount(row.available),
    reserved: amount(row.reserved),
    consumed: amount(row.consumed),
    expired: amount(row.expired),
    lifetimeGranted: amount(row.lifetimeGranted),
    netAdjusted: signedAmount(row.netAdjusted),
  };
}

function publicAccount(account: MutableAccount): CreditAccount {
  return {
    id: account.id,
    tenantId: account.tenantId,
    walletKey: account.walletKey,
    openedAt: new Date(account.openedAt),
    position: account.position,
  };
}

function mapLot(row: CreditGrantLotRow): MutableLot {
  return {
    grantTransactionId: row.grantTransactionId as CreditTransactionId,
    accountId: row.accountId as CreditAccountId,
    position: row.position,
    createdAt: new Date(row.createdAt),
    expiresAt: row.expiresAt ? new Date(row.expiresAt) : undefined,
    source: row.source ?? undefined,
    meterKeys: row.meterKeys ?? undefined,
    available: amount(row.available),
  };
}

function encodeCursor(lot: MutableLot): CreditExpiryCursor {
  return encodeURIComponent(
    JSON.stringify([lot.expiresAt?.toISOString(), lot.position, lot.grantTransactionId]),
  ) as CreditExpiryCursor;
}

function decodeCursor(cursor: CreditExpiryCursor): readonly [string, number, string] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(cursor));
  } catch {
    throw new InvalidCreditCommandProblem("expiry cursor is malformed");
  }
  if (
    Array.isArray(parsed) &&
    parsed.length === 3 &&
    typeof parsed[0] === "string" &&
    Number.isInteger(parsed[1]) &&
    Number.isFinite(Date.parse(parsed[0])) &&
    typeof parsed[2] === "string"
  ) {
    return parsed as [string, number, string];
  }
  throw new InvalidCreditCommandProblem("expiry cursor is malformed");
}

function takeAllocations(
  allocations: readonly CreditAllocation[],
  requested: CreditAmount,
): CreditAllocation[] {
  let remaining = requested;
  const result: CreditAllocation[] = [];
  for (const allocation of allocations) {
    if (compareCreditAmounts(remaining, ZERO_CREDIT_AMOUNT) === 0) break;
    const allocated =
      compareCreditAmounts(allocation.amount, remaining) <= 0 ? allocation.amount : remaining;
    result.push({ grantTransactionId: allocation.grantTransactionId, amount: allocated });
    remaining = subtractCreditAmounts(remaining, allocated);
  }
  return result;
}

function subtractAllocations(
  original: readonly CreditAllocation[],
  deducted: readonly CreditAllocation[],
): CreditAllocation[] {
  const deductedByLot = new Map<CreditTransactionId, CreditAmount>();
  for (const allocation of deducted) {
    deductedByLot.set(
      allocation.grantTransactionId,
      addCreditAmounts(
        deductedByLot.get(allocation.grantTransactionId) ?? ZERO_CREDIT_AMOUNT,
        allocation.amount,
      ),
    );
  }
  return original.flatMap((allocation) => {
    const remaining = subtractCreditAmounts(
      allocation.amount,
      deductedByLot.get(allocation.grantTransactionId) ?? ZERO_CREDIT_AMOUNT,
    );
    return compareCreditAmounts(remaining, ZERO_CREDIT_AMOUNT) > 0
      ? [{ grantTransactionId: allocation.grantTransactionId, amount: remaining }]
      : [];
  });
}

/**
 * PostgreSQL-backed credit ledger store.
 *
 * Writes lock the account row for the whole transaction. This makes allocation, balance projection,
 * reservation settlement, and immutable ledger append one atomic critical section at READ COMMITTED.
 */
export class DrizzleCreditLedgerStore extends CreditLedgerStore {
  readonly eventIntentDurability = "persistent" as const;

  constructor(
    private readonly db: DrizzleCreditClient,
    private readonly txManager: DrizzleCreditTxManager,
  ) {
    super();
  }

  async execute(command: CreditLedgerCommand): Promise<CreditCommandResult> {
    this.validateCommand(command);
    const fingerprint = stableSerialize(semanticCommand(command));
    return this.persist(command.operation, () =>
      this.txManager.run(async () => {
        const tx = this.requireTransactionClient();
        const tenantId = await this.resolveCommandTenantId(tx, command);
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${createCreditIdempotencyIdentity(
            tenantId,
            command.idempotencyKey,
          )}, 0))`,
        );
        const existing = await tx
          .select()
          .from(creditIdempotencyRecords)
          .where(
            and(
              eq(creditIdempotencyRecords.tenantId, tenantId),
              eq(creditIdempotencyRecords.key, command.idempotencyKey),
            ),
          )
          .limit(1);
        if (existing[0]) {
          if (existing[0].fingerprint !== fingerprint) {
            throw new CreditDuplicateConflictProblem(command.idempotencyKey);
          }
          const result = deserializeResult(existing[0].result);
          await this.insertEventIntent(tx, command, result);
          return result;
        }

        await this.assertCandidateIdsAvailable(tx, command);
        const result =
          command.operation === "open"
            ? await this.openAccount(tx, command)
            : await this.executeOnAccount(tx, command);
        await tx.insert(creditIdempotencyRecords).values({
          tenantId,
          key: command.idempotencyKey,
          accountId: result.account.id,
          fingerprint,
          result,
        });
        await this.insertEventIntent(tx, command, result);
        return result;
      }),
    );
  }

  async getPendingEventIntent(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<CreditLedgerEventIntent | null> {
    return this.persist("get pending event intent", async () => {
      const rows = await this.getClient()
        .select()
        .from(creditLedgerEventIntents)
        .where(
          and(
            eq(creditLedgerEventIntents.tenantId, tenantId),
            eq(creditLedgerEventIntents.idempotencyKey, idempotencyKey),
            isNull(creditLedgerEventIntents.publishedAt),
          ),
        )
        .limit(1);
      return rows[0] ? this.mapEventIntent(rows[0]) : null;
    });
  }

  async listPendingEventIntents(limit = 100): Promise<readonly CreditLedgerEventIntent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new InvalidCreditCommandProblem(
        "event intent limit must be an integer between 1 and 1000",
      );
    }
    return this.persist("list pending event intents", async () => {
      const rows = await this.getClient()
        .select()
        .from(creditLedgerEventIntents)
        .where(isNull(creditLedgerEventIntents.publishedAt))
        .orderBy(asc(creditLedgerEventIntents.createdAt), asc(creditLedgerEventIntents.eventId))
        .limit(limit);
      return rows.map((row) => this.mapEventIntent(row));
    });
  }

  async claimPendingEventIntents(
    limit = 100,
    leaseMs = 60_000,
    eventId?: string,
  ): Promise<readonly ClaimedCreditLedgerEventIntent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new InvalidCreditCommandProblem(
        "event intent limit must be an integer between 1 and 1000",
      );
    }
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 2_147_483_647) {
      throw new InvalidCreditCommandProblem(
        "event intent lease must be an integer between 1 and 2147483647 milliseconds",
      );
    }
    if (this.txManager.getClient()) {
      throw new InvalidCreditCommandProblem(
        "event intents must be claimed outside an active transaction",
      );
    }
    return this.persist("claim pending event intents", () =>
      this.db.transaction(async (tx) => {
        const candidates = await tx
          .select({ eventId: creditLedgerEventIntents.eventId })
          .from(creditLedgerEventIntents)
          .where(
            and(
              isNull(creditLedgerEventIntents.publishedAt),
              or(
                isNull(creditLedgerEventIntents.claimExpiresAt),
                lte(creditLedgerEventIntents.claimExpiresAt, sql`clock_timestamp()`),
              ),
              eventId === undefined ? undefined : eq(creditLedgerEventIntents.eventId, eventId),
            ),
          )
          .orderBy(asc(creditLedgerEventIntents.createdAt), asc(creditLedgerEventIntents.eventId))
          .limit(limit)
          .for("update", { skipLocked: true });
        if (candidates.length === 0) return [];
        const claimToken = randomUUID();
        const rows = await tx
          .update(creditLedgerEventIntents)
          .set({
            claimToken,
            claimExpiresAt: sql`clock_timestamp() + ${leaseMs} * interval '1 millisecond'`,
          })
          .where(
            inArray(
              creditLedgerEventIntents.eventId,
              candidates.map((row) => row.eventId),
            ),
          )
          .returning();
        return rows.map((row) => ({ ...this.mapEventIntent(row), claimToken }));
      }),
    );
  }

  async markEventIntentPublished(eventId: string, claimToken: string): Promise<boolean> {
    return this.persist("mark event intent published", async () => {
      const rows = await this.db
        .update(creditLedgerEventIntents)
        .set({ publishedAt: sql`clock_timestamp()`, claimToken: null, claimExpiresAt: null })
        .where(
          and(
            eq(creditLedgerEventIntents.eventId, eventId),
            eq(creditLedgerEventIntents.claimToken, claimToken),
            gt(creditLedgerEventIntents.claimExpiresAt, sql`clock_timestamp()`),
            isNull(creditLedgerEventIntents.publishedAt),
          ),
        )
        .returning({ eventId: creditLedgerEventIntents.eventId });
      return rows.length === 1;
    });
  }

  async releaseEventIntentClaim(eventId: string, claimToken: string): Promise<boolean> {
    return this.persist("release event intent claim", async () => {
      const rows = await this.db
        .update(creditLedgerEventIntents)
        .set({ claimToken: null, claimExpiresAt: null })
        .where(
          and(
            eq(creditLedgerEventIntents.eventId, eventId),
            eq(creditLedgerEventIntents.claimToken, claimToken),
            gt(creditLedgerEventIntents.claimExpiresAt, sql`clock_timestamp()`),
            isNull(creditLedgerEventIntents.publishedAt),
          ),
        )
        .returning({ eventId: creditLedgerEventIntents.eventId });
      return rows.length === 1;
    });
  }

  async getAccount(accountId: CreditAccountId): Promise<CreditAccount | null> {
    return this.persist("getAccount", async () => {
      const rows = await this.getClient()
        .select()
        .from(creditAccounts)
        .where(eq(creditAccounts.id, accountId))
        .limit(1);
      return rows[0] ? publicAccount(mapAccount(rows[0])) : null;
    });
  }

  async getBalance(accountId: CreditAccountId, atPosition?: number): Promise<CreditBalance> {
    return this.persist("getBalance", async () => {
      const client = this.getClient();
      const account = await this.requireAccount(client, accountId);
      const position = this.resolveReadPosition(account, atPosition);
      if (position === account.position) return this.balance(account, position);

      const rows = await client
        .select()
        .from(creditTransactions)
        .where(
          and(
            eq(creditTransactions.accountId, accountId),
            lte(creditTransactions.position, position),
          ),
        )
        .orderBy(asc(creditTransactions.position));
      return this.projectBalance(accountId, position, rows);
    });
  }

  async getReservation(
    accountId: CreditAccountId,
    reservationId: CreditReservationId,
  ): Promise<CreditReservation | null> {
    return this.persist("getReservation", async () => {
      const client = this.getClient();
      await this.requireAccount(client, accountId);
      const rows = await client
        .select()
        .from(creditReservations)
        .where(eq(creditReservations.id, reservationId))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      if (row.accountId !== accountId) {
        throw new CreditAccountMismatchProblem(reservationId, accountId, row.accountId);
      }
      return this.mapReservation(client, row);
    });
  }

  async getHistory(
    accountId: CreditAccountId,
    options: {
      readonly afterPosition?: number;
      readonly limit?: number;
      readonly atPosition?: number;
    } = {},
  ): Promise<CreditHistoryPage> {
    return this.persist("getHistory", async () => {
      const client = this.getClient();
      const account = await this.requireAccount(client, accountId);
      const position = this.resolveReadPosition(account, options.atPosition);
      const afterPosition = options.afterPosition ?? 0;
      const limit = options.limit ?? 100;
      if (!Number.isInteger(afterPosition) || afterPosition < 0) {
        throw new InvalidCreditCommandProblem(
          "history afterPosition must be a non-negative integer",
        );
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new InvalidCreditCommandProblem(
          "history limit must be an integer between 1 and 1000",
        );
      }
      const rows = await client
        .select()
        .from(creditTransactions)
        .where(
          and(
            eq(creditTransactions.accountId, accountId),
            gt(creditTransactions.position, afterPosition),
            lte(creditTransactions.position, position),
          ),
        )
        .orderBy(asc(creditTransactions.position))
        .limit(limit);
      return {
        accountId,
        position,
        transactions: await this.mapTransactions(client, rows),
      };
    });
  }

  private async openAccount(
    tx: DrizzleCreditTransaction,
    command: OpenCreditAccountCommand,
  ): Promise<CreditCommandResult> {
    const walletIdentity = command.walletKey ?? "";
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${command.tenantId}:${walletIdentity}`}, 1))`,
    );
    const existing = await tx
      .select()
      .from(creditAccounts)
      .where(
        and(
          eq(creditAccounts.tenantId, command.tenantId),
          eq(creditAccounts.walletIdentity, walletIdentity),
        ),
      )
      .limit(1)
      .for("update");
    if (existing[0]) {
      const account = mapAccount(existing[0]);
      this.assertExpectedPosition(account, command.expectedPosition);
      return {
        operation: "open",
        account: publicAccount(account),
        transactions: [],
        replayed: true,
      };
    }
    if (command.expectedPosition !== undefined && command.expectedPosition !== 0) {
      throw new StaleLedgerPositionProblem(command.accountId, command.expectedPosition, 0);
    }
    const duplicateId = await tx
      .select({ id: creditAccounts.id })
      .from(creditAccounts)
      .where(eq(creditAccounts.id, command.accountId))
      .limit(1);
    if (duplicateId[0]) {
      throw new InvalidCreditCommandProblem(`account ID '${command.accountId}' already exists`);
    }
    const inserted = await tx
      .insert(creditAccounts)
      .values({
        id: command.accountId,
        tenantId: command.tenantId,
        walletKey: command.walletKey,
        walletIdentity,
        openedAt: command.occurredAt,
      })
      .returning();
    const account = mapAccount(inserted[0]);
    return {
      operation: "open",
      account: publicAccount(account),
      transactions: [],
      replayed: false,
    };
  }

  private async executeOnAccount(
    tx: DrizzleCreditTransaction,
    command: Exclude<CreditLedgerCommand, OpenCreditAccountCommand>,
  ): Promise<CreditCommandResult> {
    const account = await this.requireAccount(tx, command.accountId, true);
    this.assertExpectedPosition(account, command.expectedPosition);
    let result: CreditCommandResult;
    switch (command.operation) {
      case "grant":
        result = await this.grant(tx, account, command);
        break;
      case "reserve":
        result = await this.reserve(tx, account, command);
        break;
      case "commit":
        result = await this.commit(tx, account, command);
        break;
      case "release":
        result = await this.release(tx, account, command);
        break;
      case "consume":
        result = await this.consume(tx, account, command);
        break;
      case "refund":
        result = await this.refund(tx, account, command);
        break;
      case "adjust":
        result = await this.adjust(tx, account, command);
        break;
      case "expire":
        result = await this.expire(tx, account, command);
        break;
    }
    await tx
      .update(creditAccounts)
      .set({
        position: account.position,
        available: account.available,
        reserved: account.reserved,
        consumed: account.consumed,
        expired: account.expired,
        lifetimeGranted: account.lifetimeGranted,
        netAdjusted: account.netAdjusted,
      })
      .where(eq(creditAccounts.id, account.id));
    return { ...result, account: publicAccount(account) };
  }

  private async grant(
    tx: DrizzleCreditTransaction,
    account: MutableAccount,
    command: Extract<CreditLedgerCommand, { operation: "grant" }>,
  ): Promise<CreditCommandResult> {
    const transaction = await this.appendTransaction(tx, account, {
      id: command.transactionId,
      kind: "grant",
      amount: command.amount,
      occurredAt: command.occurredAt,
      idempotencyKey: command.idempotencyKey,
      reference: command.reference,
      allocations: [],
      grant: command.grant,
    });
    await this.addLot(tx, transaction, command.grant);
    account.available = addCreditAmounts(account.available, command.amount);
    account.lifetimeGranted = addCreditAmounts(account.lifetimeGranted, command.amount);
    return this.result(command.operation, account, [transaction]);
  }

  private async reserve(
    tx: DrizzleCreditTransaction,
    account: MutableAccount,
    command: ReserveCreditsCommand,
  ): Promise<CreditCommandResult> {
    const duplicate = await tx
      .select({ accountId: creditReservations.accountId })
      .from(creditReservations)
      .where(eq(creditReservations.id, command.reservationId))
      .limit(1);
    if (duplicate[0]) {
      throw new InvalidCreditCommandProblem(
        `reservation ID '${command.reservationId}' already exists`,
      );
    }
    const allocations = await this.allocate(
      tx,
      account,
      command.amount,
      command.occurredAt,
      command.meterKey,
    );
    const reservation: CreditReservation = {
      id: command.reservationId,
      accountId: account.id,
      amount: command.amount,
      meterKey: command.meterKey,
      status: "active",
      allocations,
      createdAt: new Date(command.occurredAt),
    };
    await tx.insert(creditReservations).values({
      id: reservation.id,
      accountId: reservation.accountId,
      amount: reservation.amount,
      meterKey: reservation.meterKey,
      status: reservation.status,
      createdAt: reservation.createdAt,
    });
    const transaction = await this.appendTransaction(tx, account, {
      id: command.transactionId,
      kind: "reserve",
      amount: command.amount,
      occurredAt: command.occurredAt,
      idempotencyKey: command.idempotencyKey,
      reference: command.reference,
      allocations,
      reservationId: command.reservationId,
      meterKey: command.meterKey,
    });
    if (allocations.length > 0) {
      await tx.insert(creditReservationAllocations).values(
        allocations.map((allocation, ordinal) => ({
          reservationId: reservation.id,
          grantTransactionId: allocation.grantTransactionId,
          accountId: reservation.accountId,
          amount: allocation.amount,
          ordinal,
        })),
      );
    }
    account.available = subtractCreditAmounts(account.available, command.amount);
    account.reserved = addCreditAmounts(account.reserved, command.amount);
    return this.result(command.operation, account, [transaction], reservation);
  }

  private async commit(
    tx: DrizzleCreditTransaction,
    account: MutableAccount,
    command: CommitCreditsCommand,
  ): Promise<CreditCommandResult> {
    const reservation = await this.requireActiveReservation(tx, account.id, command.reservationId);
    if (compareCreditAmounts(command.amount, reservation.amount) > 0) {
      throw new CreditReservationMismatchProblem(
        command.reservationId,
        `commit amount ${command.amount} exceeds reserved amount ${reservation.amount}`,
      );
    }
    const committed = takeAllocations(reservation.allocations, command.amount);
    const released = subtractAllocations(reservation.allocations, committed);
    const transactions: CreditTransaction[] = [];
    if (compareCreditAmounts(command.amount, ZERO_CREDIT_AMOUNT) > 0) {
      transactions.push(
        await this.appendTransaction(tx, account, {
          id: command.commitTransactionId,
          kind: "commit",
          amount: command.amount,
          occurredAt: command.occurredAt,
          idempotencyKey: command.idempotencyKey,
          reference: command.reference,
          allocations: committed,
          reservationId: reservation.id,
          meterKey: reservation.meterKey,
        }),
      );
    }
    const releaseAmount = subtractCreditAmounts(reservation.amount, command.amount);
    if (compareCreditAmounts(releaseAmount, ZERO_CREDIT_AMOUNT) > 0) {
      await this.restoreAllocations(tx, released);
      transactions.push(
        await this.appendTransaction(tx, account, {
          id: command.releaseTransactionId,
          kind: "release",
          amount: releaseAmount,
          occurredAt: command.occurredAt,
          idempotencyKey: command.idempotencyKey,
          reference: command.reference,
          allocations: released,
          reservationId: reservation.id,
          meterKey: reservation.meterKey,
        }),
      );
    }
    const settled: CreditReservation = {
      ...reservation,
      status: "committed",
      settledAt: new Date(command.occurredAt),
    };
    await tx
      .update(creditReservations)
      .set({ status: settled.status, settledAt: settled.settledAt })
      .where(
        and(eq(creditReservations.id, reservation.id), eq(creditReservations.status, "active")),
      );
    account.reserved = subtractCreditAmounts(account.reserved, reservation.amount);
    account.consumed = addCreditAmounts(account.consumed, command.amount);
    account.available = addCreditAmounts(account.available, releaseAmount);
    return this.result(command.operation, account, transactions, settled);
  }

  private async release(
    tx: DrizzleCreditTransaction,
    account: MutableAccount,
    command: ReleaseCreditsCommand,
  ): Promise<CreditCommandResult> {
    const reservation = await this.requireActiveReservation(tx, account.id, command.reservationId);
    await this.restoreAllocations(tx, reservation.allocations);
    const transaction = await this.appendTransaction(tx, account, {
      id: command.transactionId,
      kind: "release",
      amount: reservation.amount,
      occurredAt: command.occurredAt,
      idempotencyKey: command.idempotencyKey,
      reference: command.reference,
      allocations: reservation.allocations,
      reservationId: reservation.id,
      meterKey: reservation.meterKey,
    });
    const settled: CreditReservation = {
      ...reservation,
      status: "released",
      settledAt: new Date(command.occurredAt),
    };
    await tx
      .update(creditReservations)
      .set({ status: settled.status, settledAt: settled.settledAt })
      .where(
        and(eq(creditReservations.id, reservation.id), eq(creditReservations.status, "active")),
      );
    account.reserved = subtractCreditAmounts(account.reserved, reservation.amount);
    account.available = addCreditAmounts(account.available, reservation.amount);
    return this.result(command.operation, account, [transaction], settled);
  }

  private async consume(
    tx: DrizzleCreditTransaction,
    account: MutableAccount,
    command: Extract<CreditLedgerCommand, { operation: "consume" }>,
  ): Promise<CreditCommandResult> {
    const allocations = await this.allocate(
      tx,
      account,
      command.amount,
      command.occurredAt,
      command.meterKey,
    );
    const transaction = await this.appendTransaction(tx, account, {
      id: command.transactionId,
      kind: "consume",
      amount: command.amount,
      occurredAt: command.occurredAt,
      idempotencyKey: command.idempotencyKey,
      reference: command.reference,
      allocations,
      meterKey: command.meterKey,
    });
    account.available = subtractCreditAmounts(account.available, command.amount);
    account.consumed = addCreditAmounts(account.consumed, command.amount);
    return this.result(command.operation, account, [transaction]);
  }

  private async refund(
    tx: DrizzleCreditTransaction,
    account: MutableAccount,
    command: RefundCreditsCommand,
  ): Promise<CreditCommandResult> {
    const originalRows = await tx
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.id, command.consumptionTransactionId))
      .limit(1);
    const originalRow = originalRows[0];
    if (!originalRow) {
      throw new CreditTransactionNotFoundProblem(command.consumptionTransactionId);
    }
    const [original] = await this.mapTransactions(tx, [originalRow]);
    if (original.accountId !== account.id) {
      throw new CreditAccountMismatchProblem(original.id, account.id, original.accountId);
    }
    if (original.kind !== "consume" && original.kind !== "commit") {
      throw new CreditRefundMismatchProblem(
        original.id,
        "only consumption transactions are refundable",
      );
    }
    const refundRows = await tx
      .select()
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.accountId, account.id),
          eq(creditTransactions.kind, "refund"),
          eq(creditTransactions.relatedTransactionId, original.id),
        ),
      )
      .orderBy(asc(creditTransactions.position));
    const refunds = await this.mapTransactions(tx, refundRows);
    const alreadyRefunded = refunds.reduce(
      (total, transaction) => addCreditAmounts(total, transaction.amount),
      ZERO_CREDIT_AMOUNT,
    );
    const refundable = subtractCreditAmounts(original.amount, alreadyRefunded);
    if (compareCreditAmounts(command.amount, refundable) > 0) {
      throw new CreditRefundMismatchProblem(
        original.id,
        `refund amount ${command.amount} exceeds remaining refundable amount ${refundable}`,
      );
    }
    const refundedAllocations = refunds.flatMap((transaction) => transaction.allocations);
    const allocations = takeAllocations(
      subtractAllocations(original.allocations, refundedAllocations),
      command.amount,
    );
    const lotRows =
      allocations.length === 0
        ? []
        : await tx
            .select()
            .from(creditGrantLots)
            .where(
              inArray(
                creditGrantLots.grantTransactionId,
                allocations.map((allocation) => allocation.grantTransactionId),
              ),
            );
    if (lotRows.length !== new Set(allocations.map((entry) => entry.grantTransactionId)).size) {
      throw new CreditTransactionNotFoundProblem(
        allocations.find(
          (allocation) =>
            !lotRows.some((lot) => lot.grantTransactionId === allocation.grantTransactionId),
        )?.grantTransactionId ?? original.id,
      );
    }
    const earliestExpiry = lotRows.reduce<number | undefined>(
      (earliest, lot) =>
        lot.expiresAt && lot.expiresAt.getTime() > command.occurredAt.getTime()
          ? earliest === undefined
            ? lot.expiresAt.getTime()
            : Math.min(earliest, lot.expiresAt.getTime())
          : earliest,
      undefined,
    );
    const grant: CreditGrantTerms = {
      source: `refund:${original.id}`,
      meterKeys: original.meterKey ? [original.meterKey] : undefined,
      expiresAt: earliestExpiry === undefined ? undefined : new Date(earliestExpiry),
    };
    const transaction = await this.appendTransaction(tx, account, {
      id: command.transactionId,
      kind: "refund",
      amount: command.amount,
      occurredAt: command.occurredAt,
      idempotencyKey: command.idempotencyKey,
      reference: command.reference,
      allocations,
      relatedTransactionId: original.id,
      meterKey: original.meterKey,
      grant,
    });
    await this.addLot(tx, transaction, grant);
    account.available = addCreditAmounts(account.available, command.amount);
    account.consumed = subtractCreditAmounts(account.consumed, command.amount);
    return this.result(command.operation, account, [transaction]);
  }

  private async adjust(
    tx: DrizzleCreditTransaction,
    account: MutableAccount,
    command: AdjustCreditsCommand,
  ): Promise<CreditCommandResult> {
    const allocations =
      command.direction === "debit"
        ? await this.allocate(tx, account, command.amount, command.occurredAt)
        : [];
    const grant = command.direction === "credit" ? (command.grant ?? {}) : undefined;
    const transaction = await this.appendTransaction(tx, account, {
      id: command.transactionId,
      kind: "adjustment",
      amount: command.amount,
      occurredAt: command.occurredAt,
      idempotencyKey: command.idempotencyKey,
      reference: command.reference,
      allocations,
      adjustmentDirection: command.direction,
      grant,
    });
    if (command.direction === "credit") {
      await this.addLot(tx, transaction, grant ?? {});
      account.available = addCreditAmounts(account.available, command.amount);
    } else {
      account.available = subtractCreditAmounts(account.available, command.amount);
    }
    account.netAdjusted = addSignedCreditAmounts(
      account.netAdjusted,
      toSignedCreditAmount(command.amount, command.direction),
    );
    return this.result(command.operation, account, [transaction]);
  }

  private async expire(
    tx: DrizzleCreditTransaction,
    account: MutableAccount,
    command: ExpireCreditsCommand,
  ): Promise<CreditCommandResult> {
    let cursorCondition;
    if (command.cursor) {
      const [expiresAt, position, transactionId] = decodeCursor(command.cursor);
      const expiry = new Date(expiresAt);
      cursorCondition = or(
        gt(creditGrantLots.expiresAt, expiry),
        and(
          eq(creditGrantLots.expiresAt, expiry),
          or(
            gt(creditGrantLots.position, position),
            and(
              eq(creditGrantLots.position, position),
              gt(creditGrantLots.grantTransactionId, transactionId),
            ),
          ),
        ),
      );
    }
    const rows = await tx
      .select()
      .from(creditGrantLots)
      .where(
        and(
          eq(creditGrantLots.accountId, account.id),
          isNotNull(creditGrantLots.expiresAt),
          lte(creditGrantLots.expiresAt, command.asOf),
          gt(creditGrantLots.available, "0"),
          cursorCondition,
        ),
      )
      .orderBy(
        asc(creditGrantLots.expiresAt),
        asc(creditGrantLots.position),
        asc(creditGrantLots.grantTransactionId),
      )
      .limit(command.limit + 1)
      .for("update");
    const selected = rows.slice(0, command.limit).map(mapLot);
    if (command.transactionIds.length < selected.length) {
      throw new InvalidCreditCommandProblem(
        "expiry command does not provide enough transaction IDs",
      );
    }
    const transactions: CreditTransaction[] = [];
    for (const [index, lot] of selected.entries()) {
      await tx
        .update(creditGrantLots)
        .set({ available: "0" })
        .where(eq(creditGrantLots.grantTransactionId, lot.grantTransactionId));
      transactions.push(
        await this.appendTransaction(tx, account, {
          id: command.transactionIds[index],
          kind: "expire",
          amount: lot.available,
          occurredAt: command.occurredAt,
          idempotencyKey: command.idempotencyKey,
          reference: command.reference,
          allocations: [{ grantTransactionId: lot.grantTransactionId, amount: lot.available }],
        }),
      );
      account.available = subtractCreditAmounts(account.available, lot.available);
      account.expired = addCreditAmounts(account.expired, lot.available);
    }
    const nextCursor =
      rows.length > command.limit && selected.length > 0
        ? encodeCursor(selected[selected.length - 1])
        : undefined;
    return this.result(command.operation, account, transactions, undefined, nextCursor);
  }

  private async allocate(
    tx: DrizzleCreditTransaction,
    account: MutableAccount,
    requested: CreditAmount,
    asOf: Date,
    meterKey?: string,
  ): Promise<CreditAllocation[]> {
    let remaining = requested;
    const allocations: CreditAllocation[] = [];
    const meterCondition =
      meterKey === undefined
        ? or(
            isNull(creditGrantLots.meterKeys),
            sql`jsonb_array_length(${creditGrantLots.meterKeys}) = 0`,
          )
        : or(
            isNull(creditGrantLots.meterKeys),
            sql`jsonb_array_length(${creditGrantLots.meterKeys}) = 0`,
            sql`${creditGrantLots.meterKeys} ? ${meterKey}`,
          );
    while (compareCreditAmounts(remaining, ZERO_CREDIT_AMOUNT) > 0) {
      const rows = await tx
        .select()
        .from(creditGrantLots)
        .where(
          and(
            eq(creditGrantLots.accountId, account.id),
            gt(creditGrantLots.available, "0"),
            or(isNull(creditGrantLots.expiresAt), gt(creditGrantLots.expiresAt, asOf)),
            meterCondition,
          ),
        )
        .orderBy(
          asc(creditGrantLots.expiresAt),
          asc(creditGrantLots.position),
          asc(creditGrantLots.grantTransactionId),
        )
        .limit(100)
        .for("update");
      if (rows.length === 0) break;
      for (const lot of rows.map(mapLot)) {
        const allocated =
          compareCreditAmounts(lot.available, remaining) <= 0 ? lot.available : remaining;
        await tx
          .update(creditGrantLots)
          .set({ available: subtractCreditAmounts(lot.available, allocated) })
          .where(eq(creditGrantLots.grantTransactionId, lot.grantTransactionId));
        remaining = subtractCreditAmounts(remaining, allocated);
        allocations.push({ grantTransactionId: lot.grantTransactionId, amount: allocated });
        if (compareCreditAmounts(remaining, ZERO_CREDIT_AMOUNT) === 0) break;
      }
    }
    if (compareCreditAmounts(remaining, ZERO_CREDIT_AMOUNT) > 0) {
      const expiredRows = await tx
        .select({
          available: sql<string>`coalesce(sum(${creditGrantLots.available}), 0)::text`,
        })
        .from(creditGrantLots)
        .where(
          and(
            eq(creditGrantLots.accountId, account.id),
            gt(creditGrantLots.available, "0"),
            isNotNull(creditGrantLots.expiresAt),
            lte(creditGrantLots.expiresAt, asOf),
            meterCondition,
          ),
        );
      const expiredAvailable = amount(expiredRows[0]?.available ?? "0");
      if (compareCreditAmounts(expiredAvailable, remaining) >= 0) {
        throw new ExpiredGrantProblem(account.id);
      }
      throw new InsufficientCreditsProblem(
        account.id,
        requested,
        subtractCreditAmounts(requested, remaining),
      );
    }
    return allocations;
  }

  private async restoreAllocations(
    tx: DrizzleCreditTransaction,
    allocations: readonly CreditAllocation[],
  ): Promise<void> {
    for (const allocation of allocations) {
      const rows = await tx
        .select()
        .from(creditGrantLots)
        .where(eq(creditGrantLots.grantTransactionId, allocation.grantTransactionId))
        .limit(1)
        .for("update");
      const lot = rows[0];
      if (!lot) throw new CreditTransactionNotFoundProblem(allocation.grantTransactionId);
      await tx
        .update(creditGrantLots)
        .set({ available: addCreditAmounts(amount(lot.available), allocation.amount) })
        .where(eq(creditGrantLots.grantTransactionId, allocation.grantTransactionId));
    }
  }

  private async appendTransaction(
    tx: DrizzleCreditTransaction,
    account: MutableAccount,
    input: Omit<CreditTransaction, "accountId" | "position">,
  ): Promise<CreditTransaction> {
    account.position += 1;
    const transaction: CreditTransaction = {
      ...input,
      accountId: account.id,
      position: account.position,
      occurredAt: new Date(input.occurredAt),
      reference: { ...input.reference },
      allocations: input.allocations.map((allocation) => ({ ...allocation })),
      grant: cloneGrant(input.grant),
    };
    await tx.insert(creditTransactions).values({
      id: transaction.id,
      accountId: transaction.accountId,
      position: transaction.position,
      kind: transaction.kind,
      amount: transaction.amount,
      occurredAt: transaction.occurredAt,
      idempotencyKey: transaction.idempotencyKey,
      referenceType: transaction.reference.type,
      referenceId: transaction.reference.id,
      reservationId: transaction.reservationId,
      relatedTransactionId: transaction.relatedTransactionId,
      meterKey: transaction.meterKey,
      adjustmentDirection: transaction.adjustmentDirection,
      grantExpiresAt: transaction.grant?.expiresAt,
      grantSource: transaction.grant?.source,
      grantMeterKeys: transaction.grant?.meterKeys,
    });
    if (transaction.allocations.length > 0) {
      await tx.insert(creditAllocations).values(
        transaction.allocations.map((allocation, ordinal) => ({
          transactionId: transaction.id,
          grantTransactionId: allocation.grantTransactionId,
          accountId: transaction.accountId,
          amount: allocation.amount,
          ordinal,
        })),
      );
    }
    return transaction;
  }

  private async addLot(
    tx: DrizzleCreditTransaction,
    transaction: CreditTransaction,
    grant: CreditGrantTerms,
  ): Promise<void> {
    await tx.insert(creditGrantLots).values({
      grantTransactionId: transaction.id,
      accountId: transaction.accountId,
      position: transaction.position,
      createdAt: transaction.occurredAt,
      expiresAt: grant.expiresAt,
      source: grant.source,
      meterKeys: grant.meterKeys,
      available: transaction.amount,
    });
  }

  private async requireActiveReservation(
    tx: DrizzleCreditTransaction,
    accountId: CreditAccountId,
    reservationId: CreditReservationId,
  ): Promise<CreditReservation> {
    const rows = await tx
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, reservationId))
      .limit(1)
      .for("update");
    const row = rows[0];
    if (!row) {
      throw new CreditReservationMismatchProblem(reservationId, "reservation was not found");
    }
    if (row.accountId !== accountId) {
      throw new CreditAccountMismatchProblem(reservationId, accountId, row.accountId);
    }
    if (row.status !== "active") {
      throw new CreditReservationMismatchProblem(
        reservationId,
        `reservation is already ${row.status}`,
      );
    }
    return this.mapReservation(tx, row);
  }

  private async mapReservation(
    db: DrizzleCreditClient | DrizzleCreditTransaction,
    row: CreditReservationRow,
  ): Promise<CreditReservation> {
    const allocations = await db
      .select()
      .from(creditReservationAllocations)
      .where(eq(creditReservationAllocations.reservationId, row.id))
      .orderBy(asc(creditReservationAllocations.ordinal));
    return {
      id: row.id as CreditReservationId,
      accountId: row.accountId as CreditAccountId,
      amount: amount(row.amount),
      meterKey: row.meterKey ?? undefined,
      status: row.status,
      allocations: allocations.map((allocation) => ({
        grantTransactionId: allocation.grantTransactionId as CreditTransactionId,
        amount: amount(allocation.amount),
      })),
      createdAt: new Date(row.createdAt),
      settledAt: row.settledAt ? new Date(row.settledAt) : undefined,
    };
  }

  private async mapTransactions(
    db: DrizzleCreditClient | DrizzleCreditTransaction,
    rows: readonly CreditTransactionRow[],
  ): Promise<CreditTransaction[]> {
    if (rows.length === 0) return [];
    const allocations = await db
      .select()
      .from(creditAllocations)
      .where(
        inArray(
          creditAllocations.transactionId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(asc(creditAllocations.transactionId), asc(creditAllocations.ordinal));
    const byTransaction = new Map<string, CreditAllocation[]>();
    for (const allocation of allocations) {
      const entries = byTransaction.get(allocation.transactionId) ?? [];
      entries.push({
        grantTransactionId: allocation.grantTransactionId as CreditTransactionId,
        amount: amount(allocation.amount),
      });
      byTransaction.set(allocation.transactionId, entries);
    }
    return rows.map((row) => ({
      id: row.id as CreditTransactionId,
      accountId: row.accountId as CreditAccountId,
      position: row.position,
      kind: row.kind,
      amount: amount(row.amount),
      occurredAt: new Date(row.occurredAt),
      idempotencyKey: row.idempotencyKey,
      reference: { type: row.referenceType, id: row.referenceId },
      allocations: byTransaction.get(row.id) ?? [],
      reservationId: row.reservationId ? (row.reservationId as CreditReservationId) : undefined,
      relatedTransactionId: row.relatedTransactionId
        ? (row.relatedTransactionId as CreditTransactionId)
        : undefined,
      meterKey: row.meterKey ?? undefined,
      adjustmentDirection: row.adjustmentDirection ?? undefined,
      grant:
        row.grantExpiresAt || row.grantSource || row.grantMeterKeys
          ? {
              expiresAt: row.grantExpiresAt ? new Date(row.grantExpiresAt) : undefined,
              source: row.grantSource ?? undefined,
              meterKeys: row.grantMeterKeys ?? undefined,
            }
          : undefined,
    }));
  }

  private async requireAccount(
    db: DrizzleCreditClient | DrizzleCreditTransaction,
    accountId: CreditAccountId,
    lock = false,
  ): Promise<MutableAccount> {
    const query = db.select().from(creditAccounts).where(eq(creditAccounts.id, accountId)).limit(1);
    const rows = lock ? await query.for("update") : await query;
    if (!rows[0]) throw new CreditAccountNotFoundProblem(accountId);
    return mapAccount(rows[0]);
  }

  private async resolveCommandTenantId(
    tx: DrizzleCreditTransaction,
    command: CreditLedgerCommand,
  ): Promise<string> {
    if (command.operation === "open") return command.tenantId;
    return (await this.requireAccount(tx, command.accountId)).tenantId;
  }

  private async assertCandidateIdsAvailable(
    tx: DrizzleCreditTransaction,
    command: CreditLedgerCommand,
  ): Promise<void> {
    const ids = candidateTransactionIds(command);
    if (new Set(ids).size !== ids.length) {
      throw new InvalidCreditCommandProblem("candidate transaction IDs must be unique");
    }
    if (ids.length === 0) return;
    const existing = await tx
      .select({ id: creditTransactions.id })
      .from(creditTransactions)
      .where(inArray(creditTransactions.id, ids))
      .limit(1);
    if (existing[0]) {
      throw new InvalidCreditCommandProblem(`transaction ID '${existing[0].id}' already exists`);
    }
  }

  private validateCommand(command: CreditLedgerCommand): void {
    if (command.idempotencyKey.trim().length === 0) {
      throw new InvalidCreditCommandProblem("idempotencyKey is required");
    }
    if (command.reference.type.trim().length === 0 || command.reference.id.trim().length === 0) {
      throw new InvalidCreditCommandProblem("semantic reference type and id are required");
    }
    if (Number.isNaN(command.occurredAt.getTime())) {
      throw new InvalidCreditCommandProblem("occurredAt must be a valid date");
    }
    if (
      command.expectedPosition !== undefined &&
      (!Number.isInteger(command.expectedPosition) || command.expectedPosition < 0)
    ) {
      throw new InvalidCreditCommandProblem("expectedPosition must be a non-negative integer");
    }
    if ("amount" in command && creditAmount(command.amount) !== command.amount) {
      throw new InvalidCreditCommandProblem("amount must use canonical decimal form");
    }
    if (command.operation === "open") {
      if (command.tenantId.trim().length === 0) {
        throw new InvalidCreditCommandProblem("tenantId is required");
      }
      if (command.walletKey !== undefined && command.walletKey.trim().length === 0) {
        throw new InvalidCreditCommandProblem("walletKey must not be blank");
      }
    }
    if (command.operation === "grant" || command.operation === "adjust") {
      this.validateGrant(command.grant);
    }
    if (command.operation === "expire") {
      if (!Number.isInteger(command.limit) || command.limit < 1 || command.limit > 100) {
        throw new InvalidCreditCommandProblem("expiry limit must be an integer between 1 and 100");
      }
      if (Number.isNaN(command.asOf.getTime())) {
        throw new InvalidCreditCommandProblem("expiry asOf must be a valid date");
      }
    }
  }

  private validateGrant(grant: CreditGrantTerms | undefined): void {
    if (!grant) return;
    if (grant.expiresAt && Number.isNaN(grant.expiresAt.getTime())) {
      throw new InvalidCreditCommandProblem("grant expiry must be a valid date");
    }
    if (grant.source !== undefined && grant.source.trim().length === 0) {
      throw new InvalidCreditCommandProblem("grant source must not be blank");
    }
    if (grant.meterKeys) {
      if (grant.meterKeys.some((meterKey) => meterKey.trim().length === 0)) {
        throw new InvalidCreditCommandProblem("grant meter keys must not be blank");
      }
      if (new Set(grant.meterKeys).size !== grant.meterKeys.length) {
        throw new InvalidCreditCommandProblem("grant meter keys must be unique");
      }
    }
  }

  private assertExpectedPosition(account: MutableAccount, expected: number | undefined): void {
    if (expected !== undefined && expected !== account.position) {
      throw new StaleLedgerPositionProblem(account.id, expected, account.position);
    }
  }

  private resolveReadPosition(account: MutableAccount, requested: number | undefined): number {
    if (requested === undefined) return account.position;
    if (!Number.isInteger(requested) || requested < 0 || requested > account.position) {
      throw new StaleLedgerPositionProblem(account.id, requested, account.position);
    }
    return requested;
  }

  private balance(account: MutableAccount, position: number): CreditBalance {
    return {
      accountId: account.id,
      position,
      available: account.available,
      reserved: account.reserved,
      consumed: account.consumed,
      expired: account.expired,
      lifetimeGranted: account.lifetimeGranted,
      netAdjusted: account.netAdjusted,
    };
  }

  private projectBalance(
    accountId: CreditAccountId,
    position: number,
    rows: readonly CreditTransactionRow[],
  ): CreditBalance {
    let available = ZERO_CREDIT_AMOUNT;
    let reserved = ZERO_CREDIT_AMOUNT;
    let consumed = ZERO_CREDIT_AMOUNT;
    let expired = ZERO_CREDIT_AMOUNT;
    let lifetimeGranted = ZERO_CREDIT_AMOUNT;
    let netAdjusted = ZERO_CREDIT_SIGNED_AMOUNT;
    for (const row of rows) {
      const value = amount(row.amount);
      switch (row.kind) {
        case "grant":
          available = addCreditAmounts(available, value);
          lifetimeGranted = addCreditAmounts(lifetimeGranted, value);
          break;
        case "reserve":
          available = subtractCreditAmounts(available, value);
          reserved = addCreditAmounts(reserved, value);
          break;
        case "commit":
          reserved = subtractCreditAmounts(reserved, value);
          consumed = addCreditAmounts(consumed, value);
          break;
        case "release":
          reserved = subtractCreditAmounts(reserved, value);
          available = addCreditAmounts(available, value);
          break;
        case "consume":
          available = subtractCreditAmounts(available, value);
          consumed = addCreditAmounts(consumed, value);
          break;
        case "expire":
          available = subtractCreditAmounts(available, value);
          expired = addCreditAmounts(expired, value);
          break;
        case "refund":
          available = addCreditAmounts(available, value);
          consumed = subtractCreditAmounts(consumed, value);
          break;
        case "adjustment":
          if (!row.adjustmentDirection) {
            throw new InvalidCreditCommandProblem("adjustment transaction has no direction");
          }
          available =
            row.adjustmentDirection === "credit"
              ? addCreditAmounts(available, value)
              : subtractCreditAmounts(available, value);
          netAdjusted = addSignedCreditAmounts(
            netAdjusted,
            toSignedCreditAmount(value, row.adjustmentDirection),
          );
          break;
      }
    }
    return {
      accountId,
      position,
      available,
      reserved,
      consumed,
      expired,
      lifetimeGranted,
      netAdjusted,
    };
  }

  private result(
    operation: CreditCommandResult["operation"],
    account: MutableAccount,
    transactions: readonly CreditTransaction[],
    reservation?: CreditReservation,
    nextCursor?: CreditExpiryCursor,
  ): CreditCommandResult {
    return {
      operation,
      account: publicAccount(account),
      transactions,
      reservation,
      replayed: false,
      nextCursor,
    };
  }

  private mapEventIntent(
    row: typeof creditLedgerEventIntents.$inferSelect,
  ): CreditLedgerEventIntent {
    return {
      eventId: row.eventId,
      tenantId: row.tenantId,
      idempotencyKey: row.idempotencyKey,
      occurredAt: new Date(row.occurredAt),
      data: row.data,
    };
  }

  private async insertEventIntent(
    tx: DrizzleCreditTransaction,
    command: CreditLedgerCommand,
    result: CreditCommandResult,
  ): Promise<void> {
    const eventIntent = createCreditLedgerEventIntent(command, result);
    if (!eventIntent) return;
    await tx
      .insert(creditLedgerEventIntents)
      .values({
        eventId: eventIntent.eventId,
        tenantId: eventIntent.tenantId,
        idempotencyKey: eventIntent.idempotencyKey,
        occurredAt: eventIntent.occurredAt,
        data: eventIntent.data,
      })
      .onConflictDoNothing({
        target: [creditLedgerEventIntents.tenantId, creditLedgerEventIntents.idempotencyKey],
      });
  }

  private getClient(): DrizzleCreditClient | DrizzleCreditTransaction {
    return this.txManager.getClient() ?? this.db;
  }

  private requireTransactionClient(): DrizzleCreditTransaction {
    const client = this.txManager.getClient();
    if (!client) {
      throw new CreditLedgerPersistenceProblem(
        "transaction",
        new Error("transaction client was unavailable"),
      );
    }
    return client;
  }

  private async persist<T>(operation: string, execute: () => Promise<T>): Promise<T> {
    try {
      return await execute();
    } catch (error) {
      if (error instanceof Problem) throw error;
      throw new CreditLedgerPersistenceProblem(
        operation,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
}
