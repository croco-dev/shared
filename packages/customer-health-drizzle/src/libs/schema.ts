import type {
  HealthStatus,
  HealthTransitionEventIntent,
  HealthTrend,
  SignalCategory,
} from "@croco/customer-health-core";
import {
  bigint,
  bigserial,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * 테넌트 건강 점수 이력을 저장하는 PostgreSQL 스키마입니다.
 */
export const tenantHealthScores = pgTable(
  "tenant_health_scores",
  {
    transitionSequence: bigserial("transition_sequence", { mode: "bigint" }).primaryKey(),
    tenantId: text("tenant_id").notNull(),
    overallScore: doublePrecision("overall_score").notNull(),
    status: text("status").notNull().$type<HealthStatus>(),
    categoryScores: jsonb("category_scores").$type<Record<SignalCategory, number>>().notNull(),
    signals: jsonb("signals").notNull(),
    trend: text("trend").notNull().$type<HealthTrend>(),
    previousScore: doublePrecision("previous_score"),
    calculatedAt: timestamp("calculated_at").notNull(),
  },
  (table) => [
    index("tenant_health_scores_tenant_seq_idx").on(
      table.tenantId,
      table.transitionSequence.desc(),
    ),
    index("tenant_health_scores_tenant_calc_idx").on(table.tenantId, table.calculatedAt.desc()),
  ],
);

export const tenantHealthEventIntents = pgTable(
  "tenant_health_event_intents",
  {
    eventId: text("event_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    transitionSequence: bigint("transition_sequence", { mode: "bigint" }).notNull(),
    intentOrder: integer("intent_order").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    data: jsonb("data").notNull().$type<HealthTransitionEventIntent["data"]>(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("tenant_health_event_intents_pending_idx")
      .on(table.tenantId, table.transitionSequence, table.intentOrder)
      .where(sql`${table.publishedAt} is null`),
  ],
);
