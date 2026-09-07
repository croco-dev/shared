import { randomUUID } from "node:crypto";
import type { DomainEvent } from "@croco/events-core";
import { Problem } from "@croco/problems-core";
import type { CreditLedgerStore } from "./CreditLedgerStore";
import type { ClaimedCreditLedgerEventIntent, CreditLedgerEventIntent } from "./eventIntent";
import { CreditLedgerCommittedEvent } from "./events/CreditLedgerCommittedEvent";
import { creditAccountId, creditReservationId, creditTransactionId } from "./identifiers";
import { CreditEventPublicationProblem, InvalidCreditCommandProblem } from "./problems";
import type {
  CreditAccount,
  CreditAccountId,
  CreditAmount,
  CreditBalance,
  CreditCommandResult,
  CreditExpiryCursor,
  CreditGrantTerms,
  CreditHistoryPage,
  CreditReservation,
  CreditReservationId,
  CreditSemanticReference,
  CreditTransactionId,
} from "./types";

export interface CreditLedgerEventPublisher {
  /** Must deduplicate retries and concurrent deliveries by `event.eventId`. */
  publishIdempotently(event: DomainEvent): Promise<void>;
  /** Registers service-owned publication after commit; must not execute before commit. */
  onAfterCommit(publish: () => Promise<void>): void;
}

export type CreditLedgerServiceOptions = {
  readonly store: CreditLedgerStore;
  readonly eventPublisher?: CreditLedgerEventPublisher;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly eventClaimLeaseMs?: number;
  readonly eventDelivery?: "development" | "durable";
};

type CommandMetadata = {
  readonly idempotencyKey: string;
  readonly reference: CreditSemanticReference;
  readonly expectedPosition?: number;
};

class CreditEventDeliveryFailure extends Error {
  readonly name = "CreditEventDeliveryFailure";

  constructor(readonly errors: readonly unknown[]) {
    super("Event publication and claim release failed");
  }
}

type AfterCommitFallback = "keep-pending" | "publish-now";

function resolveAfterCommitFallback(error: unknown): AfterCommitFallback | undefined {
  if (!(error instanceof Problem)) return undefined;

  switch (error.code) {
    case "events-core/after-commit-requires-active-transaction":
    case "tx-core/missing-transaction-context":
      return "publish-now";
    case "events-core/after-commit-outcome-required":
    case "tx-core/after-commit-outcome-required":
      return "keep-pending";
    default:
      return undefined;
  }
}

export type OpenCreditAccountInput = CommandMetadata & {
  readonly tenantId: string;
  readonly walletKey?: string;
};

export type GrantCreditsInput = CommandMetadata & {
  readonly accountId: CreditAccountId;
  readonly amount: CreditAmount;
  readonly expiresAt?: Date;
  readonly source?: string;
  readonly meterKeys?: readonly string[];
};

export type ReserveCreditsInput = CommandMetadata & {
  readonly accountId: CreditAccountId;
  readonly amount: CreditAmount;
  readonly meterKey?: string;
};

export type CommitCreditsInput = CommandMetadata & {
  readonly accountId: CreditAccountId;
  readonly reservationId: CreditReservationId;
  readonly amount: CreditAmount;
};

export type ReleaseCreditsInput = CommandMetadata & {
  readonly accountId: CreditAccountId;
  readonly reservationId: CreditReservationId;
};

export type ConsumeCreditsInput = CommandMetadata & {
  readonly accountId: CreditAccountId;
  readonly amount: CreditAmount;
  readonly meterKey?: string;
};

export type RefundCreditsInput = CommandMetadata & {
  readonly accountId: CreditAccountId;
  readonly consumptionTransactionId: CreditTransactionId;
  readonly amount: CreditAmount;
};

export type AdjustCreditsInput = CommandMetadata & {
  readonly accountId: CreditAccountId;
  readonly amount: CreditAmount;
  readonly direction: "credit" | "debit";
  readonly expiresAt?: Date;
  readonly source?: string;
  readonly meterKeys?: readonly string[];
};

export type ExpireCreditsInput = CommandMetadata & {
  readonly accountId: CreditAccountId;
  readonly asOf?: Date;
  readonly limit?: number;
  readonly cursor?: CreditExpiryCursor;
};

export class CreditLedgerService {
  private readonly store: CreditLedgerStore;
  private readonly eventPublisher?: CreditLedgerEventPublisher;
  private readonly eventClaimLeaseMs: number;
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;

  constructor(options: CreditLedgerServiceOptions) {
    this.store = options.store;
    this.eventPublisher = options.eventPublisher;
    this.eventClaimLeaseMs = options.eventClaimLeaseMs ?? 60_000;
    if (
      !Number.isInteger(this.eventClaimLeaseMs) ||
      this.eventClaimLeaseMs < 1 ||
      this.eventClaimLeaseMs > 2_147_483_647
    ) {
      throw new InvalidCreditCommandProblem(
        "event intent lease must be an integer between 1 and 2147483647 milliseconds",
      );
    }
    this.clock = options.clock ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? randomUUID;
    const eventDelivery = options.eventDelivery ?? "durable";
    if (eventDelivery === "durable" && this.store.eventIntentDurability !== "persistent") {
      throw new InvalidCreditCommandProblem(
        "durable event delivery requires a store with persistent event intent capability",
      );
    }
  }

  async openAccount(input: OpenCreditAccountInput): Promise<CreditCommandResult> {
    return this.execute({
      operation: "open",
      accountId: creditAccountId(this.idGenerator()),
      tenantId: input.tenantId,
      walletKey: input.walletKey,
      ...this.metadata(input),
    });
  }

  async grantCredits(input: GrantCreditsInput): Promise<CreditCommandResult> {
    return this.execute({
      operation: "grant",
      accountId: input.accountId,
      transactionId: creditTransactionId(this.idGenerator()),
      amount: input.amount,
      grant: this.grantTerms(input),
      ...this.metadata(input),
    });
  }

  async reserveCredits(input: ReserveCreditsInput): Promise<CreditCommandResult> {
    return this.execute({
      operation: "reserve",
      accountId: input.accountId,
      transactionId: creditTransactionId(this.idGenerator()),
      reservationId: creditReservationId(this.idGenerator()),
      amount: input.amount,
      meterKey: input.meterKey,
      ...this.metadata(input),
    });
  }

  async commitCredits(input: CommitCreditsInput): Promise<CreditCommandResult> {
    return this.execute({
      operation: "commit",
      accountId: input.accountId,
      reservationId: input.reservationId,
      commitTransactionId: creditTransactionId(this.idGenerator()),
      releaseTransactionId: creditTransactionId(this.idGenerator()),
      amount: input.amount,
      ...this.metadata(input),
    });
  }

  async releaseCredits(input: ReleaseCreditsInput): Promise<CreditCommandResult> {
    return this.execute({
      operation: "release",
      accountId: input.accountId,
      reservationId: input.reservationId,
      transactionId: creditTransactionId(this.idGenerator()),
      ...this.metadata(input),
    });
  }

  async consumeCredits(input: ConsumeCreditsInput): Promise<CreditCommandResult> {
    return this.execute({
      operation: "consume",
      accountId: input.accountId,
      transactionId: creditTransactionId(this.idGenerator()),
      amount: input.amount,
      meterKey: input.meterKey,
      ...this.metadata(input),
    });
  }

  async refundCredits(input: RefundCreditsInput): Promise<CreditCommandResult> {
    return this.execute({
      operation: "refund",
      accountId: input.accountId,
      transactionId: creditTransactionId(this.idGenerator()),
      consumptionTransactionId: input.consumptionTransactionId,
      amount: input.amount,
      ...this.metadata(input),
    });
  }

  async adjustCredits(input: AdjustCreditsInput): Promise<CreditCommandResult> {
    return this.execute({
      operation: "adjust",
      accountId: input.accountId,
      transactionId: creditTransactionId(this.idGenerator()),
      amount: input.amount,
      direction: input.direction,
      grant: input.direction === "credit" ? this.grantTerms(input) : undefined,
      ...this.metadata(input),
    });
  }

  async expireCredits(input: ExpireCreditsInput): Promise<CreditCommandResult> {
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new InvalidCreditCommandProblem("expiry limit must be an integer between 1 and 100");
    }
    return this.execute({
      operation: "expire",
      accountId: input.accountId,
      transactionIds: Array.from({ length: limit }, () => creditTransactionId(this.idGenerator())),
      asOf: input.asOf ? new Date(input.asOf) : this.now(),
      limit,
      cursor: input.cursor,
      ...this.metadata(input),
    });
  }

  async getAccount(accountId: CreditAccountId): Promise<CreditAccount | null> {
    return this.store.getAccount(accountId);
  }

  async getBalance(accountId: CreditAccountId, atPosition?: number): Promise<CreditBalance> {
    return this.store.getBalance(accountId, atPosition);
  }

  async getReservation(
    accountId: CreditAccountId,
    reservationId: CreditReservationId,
  ): Promise<CreditReservation | null> {
    return this.store.getReservation(accountId, reservationId);
  }

  async getHistory(
    accountId: CreditAccountId,
    options?: {
      readonly afterPosition?: number;
      readonly limit?: number;
      readonly atPosition?: number;
    },
  ): Promise<CreditHistoryPage> {
    return this.store.getHistory(accountId, options);
  }

  async publishPendingEvents(limit = 100): Promise<number> {
    if (!this.eventPublisher) {
      throw new InvalidCreditCommandProblem(
        "publishing pending events requires an idempotent event publisher",
      );
    }
    const intents = await this.store.claimPendingEventIntents(limit, this.eventClaimLeaseMs);
    const results = await Promise.allSettled(
      intents.map((intent) => this.publishClaimedIntent(intent)),
    );
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
    return intents.length;
  }

  private metadata(input: CommandMetadata): CommandMetadata & { readonly occurredAt: Date } {
    return {
      idempotencyKey: input.idempotencyKey,
      reference: { ...input.reference },
      expectedPosition: input.expectedPosition,
      occurredAt: this.now(),
    };
  }

  private grantTerms(input: {
    readonly expiresAt?: Date;
    readonly source?: string;
    readonly meterKeys?: readonly string[];
  }): CreditGrantTerms {
    return {
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
      source: input.source,
      meterKeys: input.meterKeys ? [...input.meterKeys].sort() : undefined,
    };
  }

  private now(): Date {
    const now = this.clock();
    if (Number.isNaN(now.getTime())) {
      throw new InvalidCreditCommandProblem("clock returned an invalid date");
    }
    return new Date(now);
  }

  private async execute(
    command: Parameters<CreditLedgerStore["execute"]>[0],
  ): Promise<CreditCommandResult> {
    const result = await this.store.execute(command);
    if (result.operation !== command.operation) {
      throw new InvalidCreditCommandProblem(
        `store returned '${result.operation}' for '${command.operation}'`,
      );
    }
    if (this.eventPublisher) {
      const intent = await this.store.getPendingEventIntent(
        result.account.tenantId,
        command.idempotencyKey,
      );
      if (intent) await this.publishIntentAfterCommitOrNow(intent);
    }
    return result;
  }

  private async publishIntentAfterCommitOrNow(intent: CreditLedgerEventIntent): Promise<void> {
    if (!this.eventPublisher) return;
    try {
      this.eventPublisher.onAfterCommit(() => this.publishIntentNow(intent));
    } catch (error) {
      const fallback = resolveAfterCommitFallback(error);
      if (!fallback) {
        const cause = error instanceof Error ? error : new Error(String(error));
        throw new CreditEventPublicationProblem(intent.idempotencyKey, cause);
      }
      if (fallback === "publish-now") {
        await this.publishIntentNow(intent, "keep-pending");
      }
    }
  }

  private async publishIntentNow(
    intent: CreditLedgerEventIntent,
    failureMode: "keep-pending" | "report" = "report",
  ): Promise<void> {
    if (!this.eventPublisher) return;
    try {
      const [claimed] = await this.store.claimPendingEventIntents(
        1,
        this.eventClaimLeaseMs,
        intent.eventId,
      );
      if (claimed) await this.publishClaimedIntent(claimed);
    } catch (error) {
      if (failureMode === "keep-pending") return;
      throw error;
    }
  }

  private async publishClaimedIntent(intent: ClaimedCreditLedgerEventIntent): Promise<void> {
    if (!this.eventPublisher)
      throw new InvalidCreditCommandProblem("event publication requires a publisher");
    try {
      await this.eventPublisher.publishIdempotently(
        new CreditLedgerCommittedEvent(intent.data, intent.eventId, intent.occurredAt),
      );
      if (!(await this.store.markEventIntentPublished(intent.eventId, intent.claimToken))) {
        throw new InvalidCreditCommandProblem("event intent publication lease is no longer owned");
      }
    } catch (error) {
      try {
        await this.store.releaseEventIntentClaim(intent.eventId, intent.claimToken);
      } catch (releaseError) {
        throw new CreditEventPublicationProblem(
          intent.idempotencyKey,
          new CreditEventDeliveryFailure([error, releaseError]),
        );
      }
      const cause = error instanceof Error ? error : new Error(String(error));
      throw new CreditEventPublicationProblem(intent.idempotencyKey, cause);
    }
  }
}
