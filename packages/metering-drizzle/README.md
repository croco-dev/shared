# @croco/metering-drizzle

`@croco/metering-core`용 Drizzle 저장소입니다.

## 설치

```bash
pnpm add @croco/metering-drizzle @croco/metering-core @croco/tx-core drizzle-orm
```

## 사용법

```typescript
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { TxManager } from "@croco/tx-core";
import { createDrizzleTxAdapter } from "@croco/tx-drizzle";
import { DrizzleMeterRepository, metersSqlite, usageRecordsSqlite } from "@croco/metering-drizzle";

const sqlite = new Database(":memory:");
const db = drizzle(sqlite);

const adapter = createDrizzleTxAdapter(db);
const txManager = new TxManager(adapter, { defaultNesting: "join" });

const repository = new DrizzleMeterRepository(db, txManager, {
  meterTable: metersSqlite,
  meterSchema: {
    id: metersSqlite.id,
    tenantId: metersSqlite.tenantId,
    meterId: metersSqlite.meterId,
    type: metersSqlite.type,
    quota: metersSqlite.quota,
    allowOverQuota: metersSqlite.allowOverQuota,
    metadata: metersSqlite.metadata,
    createdAt: metersSqlite.createdAt,
    updatedAt: metersSqlite.updatedAt,
  },
  usageRecordTable: usageRecordsSqlite,
  usageRecordSchema: {
    id: usageRecordsSqlite.id,
    tenantId: usageRecordsSqlite.tenantId,
    meterId: usageRecordsSqlite.meterId,
    value: usageRecordsSqlite.value,
    recordedAt: usageRecordsSqlite.recordedAt,
    metadata: usageRecordsSqlite.metadata,
    idempotencyKey: usageRecordsSqlite.idempotencyKey,
    eventId: usageRecordsSqlite.eventId,
    dimensions: usageRecordsSqlite.dimensions,
  },
});

const meter = await repository.save({
  tenantId: "tenant-1",
  meterId: "api_calls",
  type: "COUNT",
  quota: 10000,
  allowOverQuota: false,
  metadata: { description: "API calls per month" },
});

await repository.saveUsageRecords([
  {
    id: "record-1",
    tenantId: "tenant-1",
    meterId: "api_calls",
    value: 1,
    timestamp: new Date(),
    idempotencyKey: "idem-1",
    metadata: { endpoint: "/api/users" },
  },
]);

const found = await repository.findByMeterIdAndTenant("api_calls", "tenant-1");
const allMeters = await repository.findAll();
const tenantMeters = await repository.findByTenant("tenant-1");
```

기존 테이블을 업그레이드할 때는 사용하는 dialect에 맞는 migration을 실행한 뒤 새 column mapping을
설정합니다.

```ts
import type { SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import {
  addUsageEnvelopeFieldsSqlite,
  type MeteringMigrationClient,
} from "@croco/metering-drizzle";

const migrationDialect = new SQLiteSyncDialect();
const migrationClient = {
  async execute(query: unknown) {
    const rendered = migrationDialect.sqlToQuery(query as SQL);
    if (rendered.sql.trimStart().startsWith("PRAGMA")) {
      return sqlite.prepare(rendered.sql).all(...rendered.params);
    }
    return sqlite.prepare(rendered.sql).run(...rendered.params);
  },
} satisfies MeteringMigrationClient;

await addUsageEnvelopeFieldsSqlite(migrationClient);
```

PostgreSQL을 사용하는 경우에는 대신 `addUsageEnvelopeFieldsPostgres(postgresClient)`를 실행합니다.
safe-integer usage 또는 고정 소수점 quota를 사용하려면 `widenMeteringIntegersPostgres(postgresClient)`도
실행해 `usage_records.value`와 `meters.quota`를 `BIGINT`로 확장합니다.
기존 PostgreSQL 배포에서는 애플리케이션 롤아웃 전에 이 마이그레이션을 완료해야 하며, 롤링 배포 중에는
마이그레이션 완료 전 새 버전의 writer를 시작하지 않습니다.

typed usage에 `eventId` 또는 `dimensions`가 있지만 해당 mapping이 없으면
`UsageEnvelopeConfigurationProblem`으로 기록을 거부하며, billing field를 조용히 버리지 않습니다.

PostgreSQL JSONB를 그대로 쓰고 싶다면 `serializeJson`, `deserializeJson`에 패스스루 함수를 넘기면 됩니다.

`DrizzleMeterRepository`는 `replayContract: "idempotent"`를 선언합니다. 배치가 겹치거나
`UsageAggregator`의 저장 후 원본 삭제가 실패해 재시도하더라도
`(tenantId, meterId, idempotencyKey)`별 최초 기록만 저장합니다. 커스텀 테이블에도 제공 스키마와 같은
unique index가 필요합니다. 삭제가 실패하면 flush는 실패하며, 새 aggregator 인스턴스에서 재시도해도
이미 저장된 사용량은 중복 반영되지 않습니다.

## API 레퍼런스

### DrizzleMeterRepository

- `findByMeterIdAndTenant(...)`, 단일 미터 정의를 조회합니다.
- `save(meter)`, 미터 정의를 저장합니다.
- `findAll()`, 모든 미터 정의를 조회합니다.
- `findByTenant(tenantId)`, 테넌트별 미터를 조회합니다.
- `saveUsageRecords(records)`, 사용량 기록을 배치 저장합니다.

### Schema

- `metersPg`, `metersSqlite`, 미터 정의 스키마입니다.
- `usageRecordsPg`, `usageRecordsSqlite`, 사용량 기록 스키마입니다.
- `DrizzleMeterRepositoryConfig`, 컬럼 매핑과 직렬화기를 담는 설정 타입입니다.
