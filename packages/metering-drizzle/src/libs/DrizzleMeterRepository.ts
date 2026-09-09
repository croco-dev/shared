import { and, eq, getTableColumns } from "drizzle-orm";
import { InvalidUsageValueProblem, MeterRepository } from "@croco/metering-core";
import { ProblemFactory } from "@croco/problems-core";

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { ILogger } from "@croco/framework-context";
import type { MeterDefinition, MeterRegistrationOptions, UsageRecord } from "@croco/metering-core";
import type { TxManager } from "@croco/tx-core";

import { UsageEnvelopeConfigurationProblem } from "./problems/UsageEnvelopeConfigurationProblem";

const DRIZZLE_JSON_COLUMN_TYPES = new Set([
  "GelJson",
  "MySqlJson",
  "PgJson",
  "PgJsonb",
  "SingleStoreJson",
  "SQLiteBlobJson",
  "SQLiteTextJson",
]);

/**
 * 미터 저장소에서 사용하는 기본 Drizzle SQLite 클라이언트 타입입니다.
 */
export type DrizzleDb = BetterSQLite3Database<Record<string, never>>;

/**
 * 미터 정의 테이블 컬럼 매핑입니다.
 */
export type MeterTable = {
  id: SQLiteColumn;
  tenantId: SQLiteColumn;
  meterId: SQLiteColumn;
  type: SQLiteColumn;
  quota: SQLiteColumn;
  allowOverQuota: SQLiteColumn;
  metadata: SQLiteColumn;
  createdAt: SQLiteColumn;
  updatedAt: SQLiteColumn;
};

/**
 * 사용량 기록 테이블 컬럼 매핑입니다.
 */
export type UsageRecordTable = {
  id: SQLiteColumn;
  tenantId: SQLiteColumn;
  meterId: SQLiteColumn;
  value: SQLiteColumn;
  recordedAt: SQLiteColumn;
  metadata: SQLiteColumn;
  idempotencyKey: SQLiteColumn;
  eventId?: SQLiteColumn;
  dimensions?: SQLiteColumn;
};

/**
 * 저장소 초기화에 필요한 스키마와 직렬화 설정입니다.
 */
export type DrizzleMeterRepositoryConfig = {
  meterTable: unknown;
  meterSchema: MeterTable;
  usageRecordTable: unknown;
  usageRecordSchema: UsageRecordTable;
  serializeJson?: (value: unknown) => string;
  deserializeJson?: (value: string) => unknown;
};

/**
 * 미터 정의와 사용량 기록을 Drizzle로 저장하는 저장소입니다.
 */
export class DrizzleMeterRepository extends MeterRepository {
  readonly replayContract = "idempotent" as const;

  private readonly meterTable: unknown;
  private readonly meterSchema: MeterTable;
  private readonly usageRecordTable: unknown;
  private readonly usageRecordSchema: UsageRecordTable;
  private readonly serializeJson: (value: unknown) => string;
  private readonly deserializeJson: (value: string) => unknown;

  /**
   * DB, 트랜잭션 매니저, 스키마 설정을 받아 저장소를 초기화합니다.
   */
  constructor(
    private readonly db: DrizzleDb,
    private readonly txManager: TxManager<DrizzleDb>,
    config: DrizzleMeterRepositoryConfig,
    private readonly logger?: ILogger,
  ) {
    super();
    this.meterTable = config.meterTable;
    this.meterSchema = config.meterSchema;
    this.usageRecordTable = config.usageRecordTable;
    this.usageRecordSchema = config.usageRecordSchema;
    this.serializeJson = config.serializeJson ?? JSON.stringify;
    this.deserializeJson = config.deserializeJson ?? JSON.parse;
  }

  private getClient(): DrizzleDb {
    return this.txManager.getClient() ?? this.db;
  }

  /**
   * 미터 ID와 테넌트 ID로 미터 정의를 조회합니다.
   */
  async findByMeterIdAndTenant(meterId: string, tenantId: string): Promise<MeterDefinition | null> {
    const client = this.getClient();

    const results = await (client as DrizzleDb)
      .select()
      .from(this.meterTable as SQLiteTable)
      .where(and(eq(this.meterSchema.tenantId, tenantId), eq(this.meterSchema.meterId, meterId)))
      .limit(1);

    if (results.length === 0) {
      return null;
    }

    return this.mapToMeterDefinition(results[0] as Record<string, unknown>);
  }

  /**
   * 미터 정의를 저장하고 저장된 결과를 반환합니다.
   */
  async save(meter: MeterRegistrationOptions): Promise<MeterDefinition> {
    const client = this.getClient();
    const now = new Date();

    this.validateQuota(meter.quota);

    const values = {
      tenantId: meter.tenantId,
      meterId: meter.meterId,
      type: meter.type,
      quota: meter.quota ?? null,
      allowOverQuota: meter.allowOverQuota ? 1 : 0,
      metadata: this.encodeJsonColumn(meter.metadata ?? {}, this.meterSchema.metadata),
      createdAt: now.getTime(),
      updatedAt: now.getTime(),
    };

    const [inserted] = await (client as DrizzleDb)
      .insert(this.meterTable as SQLiteTable)
      .values(values)
      .returning();

    if (!inserted) {
      throw ProblemFactory.internalServerError(
        "meter/insert-failed",
        "Failed to persist meter definition",
      );
    }

    return this.mapToMeterDefinition(inserted as Record<string, unknown>);
  }

  /**
   * 모든 미터 정의를 조회합니다.
   */
  async findAll(): Promise<MeterDefinition[]> {
    const client = this.getClient();

    const results = await (client as DrizzleDb).select().from(this.meterTable as SQLiteTable);

    return (results as Record<string, unknown>[]).map((r) => this.mapToMeterDefinition(r));
  }

  /**
   * 특정 테넌트의 미터 정의를 조회합니다.
   */
  async findByTenant(tenantId: string): Promise<MeterDefinition[]> {
    const client = this.getClient();

    const results = await (client as DrizzleDb)
      .select()
      .from(this.meterTable as SQLiteTable)
      .where(eq(this.meterSchema.tenantId, tenantId));

    return (results as Record<string, unknown>[]).map((r) => this.mapToMeterDefinition(r));
  }

  /**
   * 사용량 기록을 배치로 저장합니다.
   */
  async saveUsageRecords(records: UsageRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }

    for (const record of records) {
      if (!Number.isSafeInteger(record.value) || record.value <= 0) {
        throw new InvalidUsageValueProblem(record.value);
      }
    }

    const client = this.getClient();
    const missingMappings = [
      records.some((record) => record.eventId !== undefined) &&
      this.usageRecordSchema.eventId === undefined
        ? "eventId"
        : undefined,
      records.some((record) => record.dimensions !== undefined) &&
      this.usageRecordSchema.dimensions === undefined
        ? "dimensions"
        : undefined,
    ].filter((mapping): mapping is string => mapping !== undefined);
    if (missingMappings.length > 0) {
      throw new UsageEnvelopeConfigurationProblem(missingMappings);
    }

    const columns = getTableColumns(this.usageRecordTable as SQLiteTable);
    const columnKeys = this.getUsageRecordColumnKeys(columns);
    const values = records.map((record) => {
      const value: Record<string, unknown> = {
        [columnKeys.tenantId]: record.tenantId,
        [columnKeys.meterId]: record.meterId,
        [columnKeys.value]: record.value,
        [columnKeys.recordedAt]: record.timestamp.getTime(),
        [columnKeys.metadata]: this.encodeJsonColumn(
          record.metadata ?? {},
          this.usageRecordSchema.metadata,
        ),
        [columnKeys.idempotencyKey]: record.idempotencyKey,
      };

      if (columnKeys.eventId) {
        value[columnKeys.eventId] = record.eventId ?? null;
      }
      if (columnKeys.dimensions) {
        value[columnKeys.dimensions] =
          record.dimensions === undefined
            ? null
            : this.encodeJsonColumn(record.dimensions, this.usageRecordSchema.dimensions);
      }

      return value;
    });

    await (client as DrizzleDb)
      .insert(this.usageRecordTable as SQLiteTable)
      .values(values)
      .onConflictDoNothing();
  }

  private encodeJsonColumn(value: unknown, column: unknown): unknown {
    return DRIZZLE_JSON_COLUMN_TYPES.has((column as { columnType?: string }).columnType ?? "")
      ? value
      : this.serializeJson(value);
  }

  private getUsageRecordColumnKeys(
    columns: Record<string, SQLiteColumn>,
  ): Partial<Record<keyof UsageRecordTable, string>> &
    Record<
      "tenantId" | "meterId" | "value" | "recordedAt" | "metadata" | "idempotencyKey",
      string
    > {
    return Object.fromEntries(
      Object.entries(this.usageRecordSchema)
        .filter((entry): entry is [string, SQLiteColumn] => entry[1] !== undefined)
        .map(([schemaKey, schemaColumn]) => {
          const columnKey =
            Object.entries(columns).find(([, tableColumn]) => tableColumn === schemaColumn)?.[0] ??
            schemaKey;
          return [schemaKey, columnKey];
        }),
    ) as Partial<Record<keyof UsageRecordTable, string>> &
      Record<
        "tenantId" | "meterId" | "value" | "recordedAt" | "metadata" | "idempotencyKey",
        string
      >;
  }

  private mapToMeterDefinition(raw: Record<string, unknown>): MeterDefinition {
    const quota = raw.quota === null || raw.quota === undefined ? undefined : Number(raw.quota);
    this.validateQuota(quota);

    return {
      id: String(raw.id),
      tenantId: String(raw.tenantId),
      meterId: String(raw.meterId),
      type: String(raw.type) as MeterDefinition["type"],
      quota,
      allowOverQuota: Boolean(raw.allowOverQuota),
      metadata: this.deserializeMetadata(raw.metadata),
      createdAt: this.parseDate(raw.createdAt),
      updatedAt: this.parseDate(raw.updatedAt),
    };
  }

  private validateQuota(quota: number | undefined): void {
    if (quota !== undefined && (!Number.isSafeInteger(quota) || quota < 0)) {
      throw new InvalidUsageValueProblem(
        quota,
        "quota must be an integer between 0 and Number.MAX_SAFE_INTEGER",
      );
    }
  }

  private deserializeMetadata(value: unknown): Record<string, unknown> | undefined {
    if (value === null || value === undefined) {
      return undefined;
    }
    if (typeof value === "string") {
      try {
        const parsed = this.deserializeJson(value) as Record<string, unknown>;
        return Object.keys(parsed).length === 0 ? undefined : parsed;
      } catch (error) {
        this.logger?.warn("Failed to deserialize metadata JSON", { error });
        return undefined;
      }
    }
    if (typeof value === "object" && value !== null) {
      const obj = value as Record<string, unknown>;
      return Object.keys(obj).length === 0 ? undefined : obj;
    }
    return undefined;
  }

  private parseDate(value: unknown): Date {
    if (value instanceof Date) {
      return value;
    }
    if (typeof value === "number") {
      return new Date(value);
    }
    if (typeof value === "string") {
      return new Date(value);
    }
    return new Date();
  }
}
