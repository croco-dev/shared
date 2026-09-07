import { randomUUID } from "node:crypto";
import {
  addCreditAmounts,
  addSignedCreditAmounts,
  assertPositiveCreditAmount,
  compareCreditAmounts,
  subtractCreditAmounts,
  toSignedCreditAmount,
  ZERO_CREDIT_AMOUNT,
  ZERO_CREDIT_SIGNED_AMOUNT,
} from "./amount";
import { CreditLedgerStore } from "./CreditLedgerStore";
import {
  cloneCreditLedgerEventIntent,
  createCreditLedgerEventIntent,
  type CreditLedgerEventIntent,
  type ClaimedCreditLedgerEventIntent,
} from "./eventIntent";
import {
  CreditAccountMismatchProblem,
  CreditAccountNotFoundProblem,
  CreditDuplicateConflictProblem,
  CreditRefundMismatchProblem,
  CreditReservationMismatchProblem,
  CreditTransactionNotFoundProblem,
  ExpiredGrantProblem,
  InsufficientCreditsProblem,
  InvalidCreditCommandProblem,
  StaleLedgerPositionProblem,
} from "./problems";
import type {
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
  CreditReservation,
  CreditReservationId,
  CreditTransaction,
  CreditTransactionId,
  ExpireCreditsCommand,
  GrantCreditsCommand,
  OpenCreditAccountCommand,
  RefundCreditsCommand,
  ReleaseCreditsCommand,
  ReserveCreditsCommand,
} from "./types";

type LotState = {
  readonly transactionId: CreditTransactionId;
  readonly createdAt: Date;
  readonly position: number;
  readonly grant: CreditGrantTerms;
  available: CreditAmount;
};

type AccountState = {
  account: CreditAccount;
  readonly transactions: CreditTransaction[];
  readonly reservations: Map<CreditReservationId, CreditReservation>;
  readonly lots: Map<CreditTransactionId, LotState>;
};

type IdempotencyRecord = {
  readonly fingerprint: string;
  readonly result: CreditCommandResult;
};

type AllocationOptions = {
  readonly account: AccountState;
  readonly amount: CreditAmount;
  readonly meterKey?: string;
  readonly asOf: Date;
};

function cloneReference(reference: CreditTransaction["reference"]): CreditTransaction["reference"] {
  return { ...reference };
}

function cloneGrant(grant: CreditGrantTerms | undefined): CreditGrantTerms | undefined {
  if (!grant) return undefined;
  return {
    ...grant,
    expiresAt: grant.expiresAt ? new Date(grant.expiresAt) : undefined,
    meterKeys: grant.meterKeys ? [...grant.meterKeys] : undefined,
  };
}

function cloneAllocations(allocations: readonly CreditAllocation[]): CreditAllocation[] {
  return allocations.map((allocation) => ({ ...allocation }));
}

function cloneTransaction(transaction: CreditTransaction): CreditTransaction {
  return {
    ...transaction,
    occurredAt: new Date(transaction.occurredAt),
    reference: cloneReference(transaction.reference),
    allocations: cloneAllocations(transaction.allocations),
    grant: cloneGrant(transaction.grant),
  };
}

function cloneAccount(account: CreditAccount): CreditAccount {
  return {
    ...account,
    openedAt: new Date(account.openedAt),
  };
}

function cloneReservation(
  reservation: CreditReservation | undefined,
): CreditReservation | undefined {
  if (!reservation) return undefined;
  return {
    ...reservation,
    allocations: cloneAllocations(reservation.allocations),
    createdAt: new Date(reservation.createdAt),
    settledAt: reservation.settledAt ? new Date(reservation.settledAt) : undefined,
  };
}

function cloneAccountState(state: AccountState): AccountState {
  return {
    account: cloneAccount(state.account),
    transactions: state.transactions.map(cloneTransaction),
    reservations: new Map(
      [...state.reservations].map(([id, reservation]) => [
        id,
        cloneReservation(reservation) as CreditReservation,
      ]),
    ),
    lots: new Map(
      [...state.lots].map(([id, lot]) => [
        id,
        {
          ...lot,
          createdAt: new Date(lot.createdAt),
          grant: cloneGrant(lot.grant) ?? {},
        },
      ]),
    ),
  };
}

function cloneResult(result: CreditCommandResult, replayed = result.replayed): CreditCommandResult {
  return {
    ...result,
    account: cloneAccount(result.account),
    transactions: result.transactions.map(cloneTransaction),
    reservation: cloneReservation(result.reservation),
    replayed,
  };
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
  return assertNever(command);
}

function assertNever(value: never): never {
  throw new InvalidCreditCommandProblem(`unsupported credit ledger operation '${String(value)}'`);
}

function isExpired(lot: LotState, asOf: Date): boolean {
  return lot.grant.expiresAt !== undefined && lot.grant.expiresAt.getTime() <= asOf.getTime();
}

function isMeterEligible(lot: LotState, meterKey: string | undefined): boolean {
  const restrictions = lot.grant.meterKeys;
  if (!restrictions || restrictions.length === 0) return true;
  return meterKey !== undefined && restrictions.includes(meterKey);
}

function compareLots(left: LotState, right: LotState): number {
  const leftExpiry = left.grant.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const rightExpiry = right.grant.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (leftExpiry !== rightExpiry) return leftExpiry - rightExpiry;
  if (left.position !== right.position) return left.position - right.position;
  return left.transactionId.localeCompare(right.transactionId);
}

function encodeCursor(lot: LotState): CreditExpiryCursor {
  return encodeURIComponent(
    JSON.stringify([lot.grant.expiresAt?.toISOString(), lot.position, lot.transactionId]),
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
    typeof parsed[2] === "string"
  ) {
    return parsed as [string, number, string];
  }
  throw new InvalidCreditCommandProblem("expiry cursor is malformed");
}

function isAfterCursor(lot: LotState, cursor: CreditExpiryCursor | undefined): boolean {
  if (!cursor) return true;
  const [expiresAt, position, transactionId] = decodeCursor(cursor);
  const lotExpiry = lot.grant.expiresAt?.toISOString();
  if (lotExpiry === undefined) return false;
  if (lotExpiry !== expiresAt) return lotExpiry > expiresAt;
  if (lot.position !== position) return lot.position > position;
  return lot.transactionId > transactionId;
}

export class InMemoryCreditLedgerStore extends CreditLedgerStore {
  readonly eventIntentDurability = "volatile" as const;
  private readonly accounts = new Map<CreditAccountId, AccountState>();
  private readonly accountsByTenant = new Map<string, Map<string, CreditAccountId>>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly transactionAccounts = new Map<CreditTransactionId, CreditAccountId>();
  private readonly reservationAccounts = new Map<CreditReservationId, CreditAccountId>();
  private readonly eventClaims = new Map<string, { token: string; expiresAt: number }>();
  private readonly eventIntents = new Map<string, CreditLedgerEventIntent>();

  async execute(command: CreditLedgerCommand): Promise<CreditCommandResult> {
    this.validateCommand(command);
    const fingerprint = stableSerialize(semanticCommand(command));
    const existing = this.idempotency.get(command.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new CreditDuplicateConflictProblem(command.idempotencyKey);
      }
      return cloneResult(existing.result, true);
    }
    this.assertCandidateIdsAvailable(command);

    const result =
      command.operation === "open"
        ? this.openAccount(command)
        : this.executeOnAccountAtomically(this.requireAccount(command.accountId), command);
    this.idempotency.set(command.idempotencyKey, {
      fingerprint,
      result: cloneResult(result),
    });
    const eventIntent = createCreditLedgerEventIntent(command, result);
    if (eventIntent) this.eventIntents.set(eventIntent.eventId, eventIntent);
    return cloneResult(result);
  }

  async listPendingEventIntents(limit = 100): Promise<readonly CreditLedgerEventIntent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new InvalidCreditCommandProblem(
        "event intent limit must be an integer between 1 and 1000",
      );
    }
    return [...this.eventIntents.values()].slice(0, limit).map(cloneCreditLedgerEventIntent);
  }

  async getPendingEventIntent(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<CreditLedgerEventIntent | null> {
    const intent = [...this.eventIntents.values()].find(
      (candidate) => candidate.tenantId === tenantId && candidate.idempotencyKey === idempotencyKey,
    );
    return intent ? cloneCreditLedgerEventIntent(intent) : null;
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
    if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 2_147_483_647) {
      throw new InvalidCreditCommandProblem(
        "event intent lease must be an integer between 1 and 2147483647 milliseconds",
      );
    }
    const now = Date.now();
    const claimed: ClaimedCreditLedgerEventIntent[] = [];
    for (const intent of this.eventIntents.values()) {
      if (eventId !== undefined && intent.eventId !== eventId) continue;
      const claim = this.eventClaims.get(intent.eventId);
      if (claim && claim.expiresAt > now) continue;
      const token = randomUUID();
      this.eventClaims.set(intent.eventId, { token, expiresAt: now + leaseMs });
      claimed.push({ ...cloneCreditLedgerEventIntent(intent), claimToken: token });
      if (claimed.length === limit) break;
    }
    return claimed;
  }

  async markEventIntentPublished(eventId: string, claimToken: string): Promise<boolean> {
    if (!this.ownsEventIntentClaim(eventId, claimToken)) return false;
    this.eventIntents.delete(eventId);
    this.eventClaims.delete(eventId);
    return true;
  }

  async releaseEventIntentClaim(eventId: string, claimToken: string): Promise<boolean> {
    if (!this.ownsEventIntentClaim(eventId, claimToken)) return false;
    this.eventClaims.delete(eventId);
    return true;
  }

  private ownsEventIntentClaim(eventId: string, claimToken: string): boolean {
    const claim = this.eventClaims.get(eventId);
    return claim?.token === claimToken && claim.expiresAt > Date.now();
  }

  async getAccount(accountId: CreditAccountId): Promise<CreditAccount | null> {
    const state = this.accounts.get(accountId);
    return state ? cloneAccount(state.account) : null;
  }

  async getBalance(accountId: CreditAccountId, atPosition?: number): Promise<CreditBalance> {
    const state = this.requireAccount(accountId);
    const position = this.resolveReadPosition(state, atPosition);
    let available = ZERO_CREDIT_AMOUNT;
    let reserved = ZERO_CREDIT_AMOUNT;
    let consumed = ZERO_CREDIT_AMOUNT;
    let expired = ZERO_CREDIT_AMOUNT;
    let lifetimeGranted = ZERO_CREDIT_AMOUNT;
    let netAdjusted = ZERO_CREDIT_SIGNED_AMOUNT;

    for (const transaction of state.transactions) {
      if (transaction.position > position) break;
      switch (transaction.kind) {
        case "grant":
          available = addCreditAmounts(available, transaction.amount);
          lifetimeGranted = addCreditAmounts(lifetimeGranted, transaction.amount);
          break;
        case "reserve":
          available = subtractCreditAmounts(available, transaction.amount);
          reserved = addCreditAmounts(reserved, transaction.amount);
          break;
        case "commit":
          reserved = subtractCreditAmounts(reserved, transaction.amount);
          consumed = addCreditAmounts(consumed, transaction.amount);
          break;
        case "release":
          reserved = subtractCreditAmounts(reserved, transaction.amount);
          available = addCreditAmounts(available, transaction.amount);
          break;
        case "consume":
          available = subtractCreditAmounts(available, transaction.amount);
          consumed = addCreditAmounts(consumed, transaction.amount);
          break;
        case "expire":
          available = subtractCreditAmounts(available, transaction.amount);
          expired = addCreditAmounts(expired, transaction.amount);
          break;
        case "refund":
          available = addCreditAmounts(available, transaction.amount);
          consumed = subtractCreditAmounts(consumed, transaction.amount);
          break;
        case "adjustment": {
          const direction = transaction.adjustmentDirection;
          if (!direction) {
            throw new InvalidCreditCommandProblem("adjustment transaction has no direction");
          }
          available =
            direction === "credit"
              ? addCreditAmounts(available, transaction.amount)
              : subtractCreditAmounts(available, transaction.amount);
          netAdjusted = addSignedCreditAmounts(
            netAdjusted,
            toSignedCreditAmount(transaction.amount, direction),
          );
          break;
        }
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

  async getReservation(
    accountId: CreditAccountId,
    reservationId: CreditReservationId,
  ): Promise<CreditReservation | null> {
    this.assertReservationAccount(accountId, reservationId);
    return cloneReservation(this.requireAccount(accountId).reservations.get(reservationId)) ?? null;
  }

  async getHistory(
    accountId: CreditAccountId,
    options: {
      readonly afterPosition?: number;
      readonly limit?: number;
      readonly atPosition?: number;
    } = {},
  ): Promise<CreditHistoryPage> {
    const state = this.requireAccount(accountId);
    const position = this.resolveReadPosition(state, options.atPosition);
    const afterPosition = options.afterPosition ?? 0;
    const limit = options.limit ?? 100;
    if (!Number.isInteger(afterPosition) || afterPosition < 0) {
      throw new InvalidCreditCommandProblem("history afterPosition must be a non-negative integer");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new InvalidCreditCommandProblem("history limit must be an integer between 1 and 1000");
    }
    return {
      accountId,
      position,
      transactions: state.transactions
        .filter(
          (transaction) => transaction.position > afterPosition && transaction.position <= position,
        )
        .slice(0, limit)
        .map(cloneTransaction),
    };
  }

  private openAccount(command: OpenCreditAccountCommand): CreditCommandResult {
    const walletKey = command.walletKey ?? "";
    const tenantAccounts = this.accountsByTenant.get(command.tenantId);
    const existingAccountId = tenantAccounts?.get(walletKey);
    if (existingAccountId) {
      const existing = this.requireAccount(existingAccountId);
      this.assertExpectedPosition(existing, command.expectedPosition);
      return {
        operation: "open",
        account: existing.account,
        transactions: [],
        replayed: true,
      };
    }
    if (this.accounts.has(command.accountId)) {
      throw new InvalidCreditCommandProblem(`account ID '${command.accountId}' already exists`);
    }
    if (command.expectedPosition !== undefined && command.expectedPosition !== 0) {
      throw new StaleLedgerPositionProblem(command.accountId, command.expectedPosition, 0);
    }

    const writableTenantAccounts = tenantAccounts ?? new Map<string, CreditAccountId>();
    if (!tenantAccounts) {
      this.accountsByTenant.set(command.tenantId, writableTenantAccounts);
    }
    const account: CreditAccount = {
      id: command.accountId,
      tenantId: command.tenantId,
      walletKey: command.walletKey,
      openedAt: new Date(command.occurredAt),
      position: 0,
    };
    this.accounts.set(command.accountId, {
      account,
      transactions: [],
      reservations: new Map(),
      lots: new Map(),
    });
    writableTenantAccounts.set(walletKey, command.accountId);
    return { operation: "open", account, transactions: [], replayed: false };
  }

  private executeOnAccountAtomically(
    account: AccountState,
    command: Exclude<CreditLedgerCommand, OpenCreditAccountCommand>,
  ): CreditCommandResult {
    const accountSnapshot = cloneAccountState(account);
    const transactionAccountsSnapshot = new Map(this.transactionAccounts);
    const reservationAccountsSnapshot = new Map(this.reservationAccounts);
    try {
      return this.executeOnAccount(account, command);
    } catch (error) {
      this.accounts.set(account.account.id, accountSnapshot);
      this.replaceMap(this.transactionAccounts, transactionAccountsSnapshot);
      this.replaceMap(this.reservationAccounts, reservationAccountsSnapshot);
      throw error;
    }
  }

  private executeOnAccount(
    account: AccountState,
    command: Exclude<CreditLedgerCommand, OpenCreditAccountCommand>,
  ): CreditCommandResult {
    this.assertExpectedPosition(account, command.expectedPosition);
    switch (command.operation) {
      case "grant":
        return this.grant(account, command);
      case "reserve":
        return this.reserve(account, command);
      case "commit":
        return this.commit(account, command);
      case "release":
        return this.release(account, command);
      case "consume":
        return this.consume(account, command);
      case "refund":
        return this.refund(account, command);
      case "adjust":
        return this.adjust(account, command);
      case "expire":
        return this.expire(account, command);
    }
  }

  private grant(account: AccountState, command: GrantCreditsCommand): CreditCommandResult {
    const transaction = this.appendTransaction(account, {
      id: command.transactionId,
      kind: "grant",
      amount: command.amount,
      occurredAt: command.occurredAt,
      idempotencyKey: command.idempotencyKey,
      reference: command.reference,
      allocations: [],
      grant: command.grant,
    });
    this.addLot(account, transaction, command.grant);
    return this.result(command.operation, account, [transaction]);
  }

  private reserve(account: AccountState, command: ReserveCreditsCommand): CreditCommandResult {
    this.assertNewReservation(command.reservationId);
    const allocations = this.allocate({
      account,
      amount: command.amount,
      meterKey: command.meterKey,
      asOf: command.occurredAt,
    });
    const transaction = this.appendTransaction(account, {
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
    const reservation: CreditReservation = {
      id: command.reservationId,
      accountId: account.account.id,
      amount: command.amount,
      meterKey: command.meterKey,
      status: "active",
      allocations: cloneAllocations(allocations),
      createdAt: new Date(command.occurredAt),
    };
    account.reservations.set(command.reservationId, reservation);
    this.reservationAccounts.set(command.reservationId, account.account.id);
    return this.result(command.operation, account, [transaction], reservation);
  }

  private commit(account: AccountState, command: CommitCreditsCommand): CreditCommandResult {
    const reservation = this.requireActiveReservation(account, command.reservationId);
    if (compareCreditAmounts(command.amount, reservation.amount) > 0) {
      throw new CreditReservationMismatchProblem(
        command.reservationId,
        `commit amount ${command.amount} exceeds reserved amount ${reservation.amount}`,
      );
    }

    const committed = this.takeAllocations(reservation.allocations, command.amount);
    const released = this.subtractAllocations(reservation.allocations, committed);
    const transactions: CreditTransaction[] = [];
    if (compareCreditAmounts(command.amount, ZERO_CREDIT_AMOUNT) > 0) {
      transactions.push(
        this.appendTransaction(account, {
          id: command.commitTransactionId,
          kind: "commit",
          amount: command.amount,
          occurredAt: command.occurredAt,
          idempotencyKey: command.idempotencyKey,
          reference: command.reference,
          allocations: committed,
          reservationId: command.reservationId,
          meterKey: reservation.meterKey,
        }),
      );
    }
    const releaseAmount = subtractCreditAmounts(reservation.amount, command.amount);
    if (compareCreditAmounts(releaseAmount, ZERO_CREDIT_AMOUNT) > 0) {
      this.restoreAllocations(account, released);
      transactions.push(
        this.appendTransaction(account, {
          id: command.releaseTransactionId,
          kind: "release",
          amount: releaseAmount,
          occurredAt: command.occurredAt,
          idempotencyKey: command.idempotencyKey,
          reference: command.reference,
          allocations: released,
          reservationId: command.reservationId,
          meterKey: reservation.meterKey,
        }),
      );
    }
    const settled: CreditReservation = {
      ...reservation,
      status: "committed",
      settledAt: new Date(command.occurredAt),
    };
    account.reservations.set(command.reservationId, settled);
    return this.result(command.operation, account, transactions, settled);
  }

  private release(account: AccountState, command: ReleaseCreditsCommand): CreditCommandResult {
    const reservation = this.requireActiveReservation(account, command.reservationId);
    this.restoreAllocations(account, reservation.allocations);
    const transaction = this.appendTransaction(account, {
      id: command.transactionId,
      kind: "release",
      amount: reservation.amount,
      occurredAt: command.occurredAt,
      idempotencyKey: command.idempotencyKey,
      reference: command.reference,
      allocations: reservation.allocations,
      reservationId: command.reservationId,
      meterKey: reservation.meterKey,
    });
    const settled: CreditReservation = {
      ...reservation,
      status: "released",
      settledAt: new Date(command.occurredAt),
    };
    account.reservations.set(command.reservationId, settled);
    return this.result(command.operation, account, [transaction], settled);
  }

  private consume(
    account: AccountState,
    command: Extract<CreditLedgerCommand, { operation: "consume" }>,
  ): CreditCommandResult {
    const allocations = this.allocate({
      account,
      amount: command.amount,
      meterKey: command.meterKey,
      asOf: command.occurredAt,
    });
    const transaction = this.appendTransaction(account, {
      id: command.transactionId,
      kind: "consume",
      amount: command.amount,
      occurredAt: command.occurredAt,
      idempotencyKey: command.idempotencyKey,
      reference: command.reference,
      allocations,
      meterKey: command.meterKey,
    });
    return this.result(command.operation, account, [transaction]);
  }

  private refund(account: AccountState, command: RefundCreditsCommand): CreditCommandResult {
    const original = this.requireTransaction(command.consumptionTransactionId);
    if (original.accountId !== account.account.id) {
      throw new CreditAccountMismatchProblem(original.id, account.account.id, original.accountId);
    }
    if (original.kind !== "consume" && original.kind !== "commit") {
      throw new CreditRefundMismatchProblem(
        original.id,
        "only consumption transactions are refundable",
      );
    }
    const alreadyRefunded = account.transactions
      .filter(
        (transaction) =>
          transaction.kind === "refund" && transaction.relatedTransactionId === original.id,
      )
      .reduce(
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
    const allocations = this.refundAllocations(
      original.allocations,
      account.transactions.filter(
        (transaction) =>
          transaction.kind === "refund" && transaction.relatedTransactionId === original.id,
      ),
      command.amount,
    );
    const refundedExpiries = allocations.flatMap((allocation) => {
      const lot = account.lots.get(allocation.grantTransactionId);
      if (!lot) {
        throw new CreditTransactionNotFoundProblem(allocation.grantTransactionId);
      }
      return lot.grant.expiresAt ? [lot.grant.expiresAt] : [];
    });
    const earliestExpiry = refundedExpiries.reduce<number | undefined>(
      (earliest, expiry) =>
        earliest === undefined ? expiry.getTime() : Math.min(earliest, expiry.getTime()),
      undefined,
    );
    const expiresAt = earliestExpiry === undefined ? undefined : new Date(earliestExpiry);
    const grant: CreditGrantTerms = {
      source: `refund:${original.id}`,
      meterKeys: original.meterKey ? [original.meterKey] : undefined,
      expiresAt,
    };
    const transaction = this.appendTransaction(account, {
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
    this.addLot(account, transaction, grant);
    return this.result(command.operation, account, [transaction]);
  }

  private adjust(account: AccountState, command: AdjustCreditsCommand): CreditCommandResult {
    const allocations =
      command.direction === "debit"
        ? this.allocate({
            account,
            amount: command.amount,
            asOf: command.occurredAt,
          })
        : [];
    const grant = command.direction === "credit" ? (command.grant ?? {}) : undefined;
    const transaction = this.appendTransaction(account, {
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
    if (command.direction === "credit") this.addLot(account, transaction, grant ?? {});
    return this.result(command.operation, account, [transaction]);
  }

  private expire(account: AccountState, command: ExpireCreditsCommand): CreditCommandResult {
    const candidates = [...account.lots.values()]
      .filter(
        (lot) =>
          isExpired(lot, command.asOf) &&
          compareCreditAmounts(lot.available, ZERO_CREDIT_AMOUNT) > 0 &&
          isAfterCursor(lot, command.cursor),
      )
      .sort(compareLots);
    const selected = candidates.slice(0, command.limit);
    if (command.transactionIds.length < selected.length) {
      throw new InvalidCreditCommandProblem(
        "expiry command does not provide enough transaction IDs",
      );
    }
    const transactions = selected.map((lot, index) => {
      const amount = lot.available;
      lot.available = ZERO_CREDIT_AMOUNT;
      return this.appendTransaction(account, {
        id: command.transactionIds[index],
        kind: "expire",
        amount,
        occurredAt: command.occurredAt,
        idempotencyKey: command.idempotencyKey,
        reference: command.reference,
        allocations: [{ grantTransactionId: lot.transactionId, amount }],
      });
    });
    const nextCursor =
      candidates.length > selected.length && selected.length > 0
        ? encodeCursor(selected[selected.length - 1])
        : undefined;
    return this.result(command.operation, account, transactions, undefined, nextCursor);
  }

  private allocate(options: AllocationOptions): CreditAllocation[] {
    const eligible = [...options.account.lots.values()]
      .filter(
        (lot) =>
          !isExpired(lot, options.asOf) &&
          isMeterEligible(lot, options.meterKey) &&
          compareCreditAmounts(lot.available, ZERO_CREDIT_AMOUNT) > 0,
      )
      .sort(compareLots);
    const available = eligible.reduce(
      (total, lot) => addCreditAmounts(total, lot.available),
      ZERO_CREDIT_AMOUNT,
    );
    if (compareCreditAmounts(available, options.amount) < 0) {
      const expiredAvailable = [...options.account.lots.values()]
        .filter(
          (lot) =>
            isExpired(lot, options.asOf) &&
            isMeterEligible(lot, options.meterKey) &&
            compareCreditAmounts(lot.available, ZERO_CREDIT_AMOUNT) > 0,
        )
        .reduce((total, lot) => addCreditAmounts(total, lot.available), ZERO_CREDIT_AMOUNT);
      if (
        compareCreditAmounts(addCreditAmounts(available, expiredAvailable), options.amount) >= 0
      ) {
        throw new ExpiredGrantProblem(options.account.account.id);
      }
      throw new InsufficientCreditsProblem(options.account.account.id, options.amount, available);
    }

    let remaining = options.amount;
    const allocations: CreditAllocation[] = [];
    for (const lot of eligible) {
      if (compareCreditAmounts(remaining, ZERO_CREDIT_AMOUNT) === 0) break;
      const amount =
        compareCreditAmounts(lot.available, remaining) <= 0 ? lot.available : remaining;
      lot.available = subtractCreditAmounts(lot.available, amount);
      remaining = subtractCreditAmounts(remaining, amount);
      allocations.push({ grantTransactionId: lot.transactionId, amount });
    }
    return allocations;
  }

  private takeAllocations(
    allocations: readonly CreditAllocation[],
    requested: CreditAmount,
  ): CreditAllocation[] {
    let remaining = requested;
    const result: CreditAllocation[] = [];
    for (const allocation of allocations) {
      if (compareCreditAmounts(remaining, ZERO_CREDIT_AMOUNT) === 0) break;
      const amount =
        compareCreditAmounts(allocation.amount, remaining) <= 0 ? allocation.amount : remaining;
      result.push({
        grantTransactionId: allocation.grantTransactionId,
        amount,
      });
      remaining = subtractCreditAmounts(remaining, amount);
    }
    return result;
  }

  private subtractAllocations(
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
        ? [
            {
              grantTransactionId: allocation.grantTransactionId,
              amount: remaining,
            },
          ]
        : [];
    });
  }

  private refundAllocations(
    original: readonly CreditAllocation[],
    refunds: readonly CreditTransaction[],
    requested: CreditAmount,
  ): CreditAllocation[] {
    const refunded = refunds.flatMap((transaction) => transaction.allocations);
    const remainingOriginal = this.subtractAllocations(original, refunded);
    return this.takeAllocations(remainingOriginal, requested);
  }

  private restoreAllocations(
    account: AccountState,
    allocations: readonly CreditAllocation[],
  ): void {
    for (const allocation of allocations) {
      const lot = account.lots.get(allocation.grantTransactionId);
      if (!lot) {
        throw new CreditTransactionNotFoundProblem(allocation.grantTransactionId);
      }
      lot.available = addCreditAmounts(lot.available, allocation.amount);
    }
  }

  private appendTransaction(
    account: AccountState,
    input: Omit<CreditTransaction, "accountId" | "position">,
  ): CreditTransaction {
    if (this.transactionAccounts.has(input.id)) {
      throw new InvalidCreditCommandProblem(`transaction ID '${input.id}' already exists`);
    }
    const transaction: CreditTransaction = {
      ...input,
      accountId: account.account.id,
      position: account.account.position + 1,
      occurredAt: new Date(input.occurredAt),
      reference: cloneReference(input.reference),
      allocations: cloneAllocations(input.allocations),
      grant: cloneGrant(input.grant),
    };
    account.transactions.push(transaction);
    account.account = { ...account.account, position: transaction.position };
    this.transactionAccounts.set(transaction.id, account.account.id);
    return transaction;
  }

  private addLot(
    account: AccountState,
    transaction: CreditTransaction,
    grant: CreditGrantTerms,
  ): void {
    account.lots.set(transaction.id, {
      transactionId: transaction.id,
      createdAt: new Date(transaction.occurredAt),
      position: transaction.position,
      grant: cloneGrant(grant) ?? {},
      available: transaction.amount,
    });
  }

  private result(
    operation: CreditCommandResult["operation"],
    account: AccountState,
    transactions: readonly CreditTransaction[],
    reservation?: CreditReservation,
    nextCursor?: CreditExpiryCursor,
  ): CreditCommandResult {
    return {
      operation,
      account: account.account,
      transactions,
      reservation,
      replayed: false,
      nextCursor,
    };
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
    if ("amount" in command) assertPositiveCreditAmount(command.amount);
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

  private assertCandidateIdsAvailable(command: CreditLedgerCommand): void {
    const transactionIds =
      command.operation === "commit"
        ? [command.commitTransactionId, command.releaseTransactionId]
        : command.operation === "expire"
          ? command.transactionIds
          : "transactionId" in command
            ? [command.transactionId]
            : [];
    if (new Set(transactionIds).size !== transactionIds.length) {
      throw new InvalidCreditCommandProblem("candidate transaction IDs must be unique");
    }
    for (const transactionId of transactionIds) {
      if (this.transactionAccounts.has(transactionId)) {
        throw new InvalidCreditCommandProblem(`transaction ID '${transactionId}' already exists`);
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

  private requireAccount(accountId: CreditAccountId): AccountState {
    const account = this.accounts.get(accountId);
    if (!account) throw new CreditAccountNotFoundProblem(accountId);
    return account;
  }

  private requireTransaction(transactionId: CreditTransactionId): CreditTransaction {
    const accountId = this.transactionAccounts.get(transactionId);
    if (!accountId) throw new CreditTransactionNotFoundProblem(transactionId);
    const transaction = this.requireAccount(accountId).transactions.find(
      (candidate) => candidate.id === transactionId,
    );
    if (!transaction) throw new CreditTransactionNotFoundProblem(transactionId);
    return transaction;
  }

  private assertExpectedPosition(account: AccountState, expected: number | undefined): void {
    if (expected !== undefined && expected !== account.account.position) {
      throw new StaleLedgerPositionProblem(account.account.id, expected, account.account.position);
    }
  }

  private resolveReadPosition(account: AccountState, requested: number | undefined): number {
    if (requested === undefined) return account.account.position;
    if (!Number.isInteger(requested) || requested < 0 || requested > account.account.position) {
      throw new StaleLedgerPositionProblem(account.account.id, requested, account.account.position);
    }
    return requested;
  }

  private assertNewReservation(reservationId: CreditReservationId): void {
    if (this.reservationAccounts.has(reservationId)) {
      throw new InvalidCreditCommandProblem(`reservation ID '${reservationId}' already exists`);
    }
  }

  private assertReservationAccount(
    accountId: CreditAccountId,
    reservationId: CreditReservationId,
  ): void {
    const actualAccountId = this.reservationAccounts.get(reservationId);
    if (actualAccountId && actualAccountId !== accountId) {
      throw new CreditAccountMismatchProblem(reservationId, accountId, actualAccountId);
    }
  }

  private requireActiveReservation(
    account: AccountState,
    reservationId: CreditReservationId,
  ): CreditReservation {
    this.assertReservationAccount(account.account.id, reservationId);
    const reservation = account.reservations.get(reservationId);
    if (!reservation) {
      throw new CreditReservationMismatchProblem(reservationId, "reservation was not found");
    }
    if (reservation.status !== "active") {
      throw new CreditReservationMismatchProblem(
        reservationId,
        `reservation is already ${reservation.status}`,
      );
    }
    return reservation;
  }

  private replaceMap<Key, Value>(target: Map<Key, Value>, source: Map<Key, Value>): void {
    target.clear();
    for (const [key, value] of source) {
      target.set(key, value);
    }
  }
}
