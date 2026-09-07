import type {
  CreditLedgerCommittedEventData,
  CreditReservation,
  CreditTransactionKind,
} from "@croco/credits-core";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const amount = (name: string) => numeric(name);

export const creditAccounts = pgTable(
  "credit_accounts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    walletKey: text("wallet_key"),
    walletIdentity: text("wallet_identity").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    position: bigint("position", { mode: "number" }).notNull().default(0),
    available: amount("available").notNull().default("0"),
    reserved: amount("reserved").notNull().default("0"),
    consumed: amount("consumed").notNull().default("0"),
    expired: amount("expired").notNull().default("0"),
    lifetimeGranted: amount("lifetime_granted").notNull().default("0"),
    netAdjusted: amount("net_adjusted").notNull().default("0"),
  },
  (table) => [
    uniqueIndex("credit_accounts_tenant_wallet_unique").on(table.tenantId, table.walletIdentity),
    check("credit_accounts_position_nonnegative", sql`${table.position} >= 0`),
    check(
      "credit_accounts_balances_nonnegative",
      sql`${table.available} >= 0
        and ${table.reserved} >= 0
        and ${table.consumed} >= 0
        and ${table.expired} >= 0
        and ${table.lifetimeGranted} >= 0`,
    ),
  ],
);

export const creditReservations = pgTable(
  "credit_reservations",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => creditAccounts.id),
    amount: amount("amount").notNull(),
    meterKey: text("meter_key"),
    status: text("status", { enum: ["active", "committed", "released"] })
      .notNull()
      .$type<CreditReservation["status"]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("credit_reservations_id_account_unique").on(table.id, table.accountId),
    index("credit_reservations_account_idx").on(table.accountId),
    check("credit_reservations_amount_positive", sql`${table.amount} > 0`),
    check(
      "credit_reservations_status_valid",
      sql`${table.status} in ('active', 'committed', 'released')`,
    ),
  ],
);

export const creditTransactions = pgTable(
  "credit_transactions",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => creditAccounts.id),
    position: bigint("position", { mode: "number" }).notNull(),
    kind: text("kind").notNull().$type<CreditTransactionKind>(),
    amount: amount("amount").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    referenceType: text("reference_type").notNull(),
    referenceId: text("reference_id").notNull(),
    reservationId: text("reservation_id"),
    relatedTransactionId: text("related_transaction_id"),
    meterKey: text("meter_key"),
    adjustmentDirection: text("adjustment_direction", { enum: ["credit", "debit"] }),
    grantExpiresAt: timestamp("grant_expires_at", { withTimezone: true }),
    grantSource: text("grant_source"),
    grantMeterKeys: jsonb("grant_meter_keys").$type<readonly string[]>(),
  },
  (table) => [
    uniqueIndex("credit_transactions_id_account_unique").on(table.id, table.accountId),
    uniqueIndex("credit_transactions_account_position_unique").on(table.accountId, table.position),
    index("credit_transactions_account_history_idx").on(table.accountId, table.position),
    index("credit_transactions_related_idx").on(table.relatedTransactionId),
    foreignKey({
      name: "credit_transactions_reservation_account_fk",
      columns: [table.reservationId, table.accountId],
      foreignColumns: [creditReservations.id, creditReservations.accountId],
    }),
    foreignKey({
      name: "credit_transactions_related_account_fk",
      columns: [table.relatedTransactionId, table.accountId],
      foreignColumns: [table.id, table.accountId],
    }),
    check("credit_transactions_amount_positive", sql`${table.amount} > 0`),
    check(
      "credit_transactions_kind_valid",
      sql`${table.kind} in (
        'grant',
        'reserve',
        'commit',
        'release',
        'consume',
        'expire',
        'refund',
        'adjustment'
      )`,
    ),
    check(
      "credit_transactions_adjustment_direction_valid",
      sql`${table.adjustmentDirection} is null
        or ${table.adjustmentDirection} in ('credit', 'debit')`,
    ),
  ],
);

export const creditGrantLots = pgTable(
  "credit_grant_lots",
  {
    grantTransactionId: text("grant_transaction_id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => creditAccounts.id),
    position: bigint("position", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    source: text("source"),
    meterKeys: jsonb("meter_keys").$type<readonly string[]>(),
    available: amount("available").notNull(),
  },
  (table) => [
    foreignKey({
      name: "credit_grant_lots_transaction_account_fk",
      columns: [table.grantTransactionId, table.accountId],
      foreignColumns: [creditTransactions.id, creditTransactions.accountId],
    }),
    uniqueIndex("credit_grant_lots_id_account_unique").on(
      table.grantTransactionId,
      table.accountId,
    ),
    index("credit_grant_lots_allocation_idx").on(
      table.accountId,
      table.expiresAt,
      table.position,
      table.grantTransactionId,
    ),
    check("credit_grant_lots_available_nonnegative", sql`${table.available} >= 0`),
  ],
);

export const creditAllocations = pgTable(
  "credit_allocations",
  {
    transactionId: text("transaction_id").notNull(),
    grantTransactionId: text("grant_transaction_id").notNull(),
    accountId: text("account_id")
      .notNull()
      .references(() => creditAccounts.id),
    amount: amount("amount").notNull(),
    ordinal: bigint("ordinal", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "credit_allocations_primary",
      columns: [table.transactionId, table.ordinal],
    }),
    foreignKey({
      name: "credit_allocations_transaction_account_fk",
      columns: [table.transactionId, table.accountId],
      foreignColumns: [creditTransactions.id, creditTransactions.accountId],
    }),
    foreignKey({
      name: "credit_allocations_grant_account_fk",
      columns: [table.grantTransactionId, table.accountId],
      foreignColumns: [creditGrantLots.grantTransactionId, creditGrantLots.accountId],
    }),
    check("credit_allocations_amount_positive", sql`${table.amount} > 0`),
  ],
);

export const creditReservationAllocations = pgTable(
  "credit_reservation_allocations",
  {
    reservationId: text("reservation_id").notNull(),
    grantTransactionId: text("grant_transaction_id").notNull(),
    accountId: text("account_id")
      .notNull()
      .references(() => creditAccounts.id),
    amount: amount("amount").notNull(),
    ordinal: bigint("ordinal", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "credit_reservation_allocations_primary",
      columns: [table.reservationId, table.ordinal],
    }),
    foreignKey({
      name: "credit_reservation_allocations_reservation_account_fk",
      columns: [table.reservationId, table.accountId],
      foreignColumns: [creditReservations.id, creditReservations.accountId],
    }),
    foreignKey({
      name: "credit_reservation_allocations_grant_account_fk",
      columns: [table.grantTransactionId, table.accountId],
      foreignColumns: [creditGrantLots.grantTransactionId, creditGrantLots.accountId],
    }),
    check("credit_reservation_allocations_amount_positive", sql`${table.amount} > 0`),
  ],
);

export const creditIdempotencyRecords = pgTable(
  "credit_idempotency_records",
  {
    tenantId: text("tenant_id").notNull(),
    key: text("key").notNull(),
    accountId: text("account_id").references(() => creditAccounts.id),
    fingerprint: text("fingerprint").notNull(),
    result: jsonb("result").notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "credit_idempotency_records_pkey",
      columns: [table.tenantId, table.key],
    }),
  ],
);

export const creditLedgerEventIntents = pgTable(
  "credit_ledger_event_intents",
  {
    eventId: text("event_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    data: jsonb("data").notNull().$type<CreditLedgerCommittedEventData>(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    claimToken: text("claim_token"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "credit_ledger_event_intents_idempotency_fk",
      columns: [table.tenantId, table.idempotencyKey],
      foreignColumns: [creditIdempotencyRecords.tenantId, creditIdempotencyRecords.key],
    }),
    uniqueIndex("credit_ledger_event_intents_idempotency_unique").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    index("credit_ledger_event_intents_pending_idx")
      .on(table.createdAt, table.eventId)
      .where(sql`${table.publishedAt} is null`),
  ],
);

export type CreditAccountRow = typeof creditAccounts.$inferSelect;
export type CreditTransactionRow = typeof creditTransactions.$inferSelect;
export type CreditGrantLotRow = typeof creditGrantLots.$inferSelect;
export type CreditReservationRow = typeof creditReservations.$inferSelect;
