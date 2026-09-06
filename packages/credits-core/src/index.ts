/**
 * @packageDocumentation
 *
 * Provider-neutral append-only credit ledger for grants, reservations, usage settlement,
 * expiry, refunds, and compensating adjustments.
 */

export {
  addCreditAmounts,
  addSignedCreditAmounts,
  compareCreditAmounts,
  creditAmount,
  subtractCreditAmounts,
  toSignedCreditAmount,
  ZERO_CREDIT_AMOUNT,
  ZERO_CREDIT_SIGNED_AMOUNT,
} from "./libs/amount";
export {
  type AdjustCreditsInput,
  type CommitCreditsInput,
  type ConsumeCreditsInput,
  type CreditLedgerEventPublisher,
  CreditLedgerService,
  type CreditLedgerServiceOptions,
  type ExpireCreditsInput,
  type GrantCreditsInput,
  type OpenCreditAccountInput,
  type RefundCreditsInput,
  type ReleaseCreditsInput,
  type ReserveCreditsInput,
} from "./libs/CreditLedgerService";
export { CreditLedgerStore } from "./libs/CreditLedgerStore";
export {
  createCreditIdempotencyIdentity,
  createCreditLedgerEventIntent,
  type CreditLedgerEventIntent,
  type ClaimedCreditLedgerEventIntent,
} from "./libs/eventIntent";
export {
  type CreditLedgerStoreConformanceCase,
  type CreditLedgerStoreConformanceOptions,
  type CreditLedgerStoreConformanceSuite,
  createCreditLedgerStoreConformanceSuite,
} from "./libs/conformance";
export {
  CreditLedgerCommittedEvent,
  type CreditLedgerCommittedEventData,
} from "./libs/events/CreditLedgerCommittedEvent";
export { InMemoryCreditLedgerStore } from "./libs/InMemoryCreditLedgerStore";
export { creditAccountId, creditReservationId, creditTransactionId } from "./libs/identifiers";
export {
  CreditAccountMismatchProblem,
  CreditAccountNotFoundProblem,
  CreditDuplicateConflictProblem,
  CreditEventPublicationProblem,
  CreditRefundMismatchProblem,
  CreditReservationMismatchProblem,
  CreditTransactionNotFoundProblem,
  ExpiredGrantProblem,
  InsufficientCreditsProblem,
  InvalidCreditAmountProblem,
  InvalidCreditCommandProblem,
  StaleLedgerPositionProblem,
} from "./libs/problems";
export type {
  AdjustCreditsCommand,
  CommitCreditsCommand,
  ConsumeCreditsCommand,
  CreditAccount,
  CreditAccountId,
  CreditAllocation,
  CreditAmount,
  CreditBalance,
  CreditCommandBase,
  CreditCommandResult,
  CreditExpiryCursor,
  CreditGrantTerms,
  CreditHistoryPage,
  CreditLedgerCommand,
  CreditReservation,
  CreditReservationId,
  CreditSemanticReference,
  CreditSignedAmount,
  CreditTransaction,
  CreditTransactionId,
  CreditTransactionKind,
  ExpireCreditsCommand,
  GrantCreditsCommand,
  OpenCreditAccountCommand,
  RefundCreditsCommand,
  ReleaseCreditsCommand,
  ReserveCreditsCommand,
} from "./libs/types";
