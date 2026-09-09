/**
 * @packageDocumentation
 *
 * @croco/metering-core
 *
 * Usage Metering 핵심 패키지 - SaaS 애플리케이션을 위한 사용량 측정 및 quota 관리
 *
 * ## 핵심 기능
 *
 * - **사용량 기록**: API 호출, 스토리지, 대역폭 등 다양한 메트릭 추적
 * - **Quota 관리**: 테넌트별 사용량 제한 및 초과 처리
 * - **Idempotency**: 중복 기록 방지 (24시간 TTL)
 * - **실시간 집계**: Redis 기반 실시간 사용량 조회
 * - **배치 저장**: 장기 보관을 위한 DB 영구 저장
 * - **이벤트 발행**: billing-core와 연동을 위한 이벤트 기반 통합
 *
 * @example
 * ```typescript
 * import {
 *   defineMeter,
 *   dimension,
 *   MeteringService,
 *   MeterRegistry,
 *   IdempotencyManager,
 *   RedisUsageStorage,
 *   setMeteringService,
 * } from '@croco/metering-core';
 *
 * // Redis 클라이언트 (ioredis, upstash 등)
 * const redisClient = createRedisClient();
 *
 * // 구성 요소 초기화
 * const usageStorage = new RedisUsageStorage(redisClient);
 * const idempotencyManager = new IdempotencyManager(redisClient);
 * const meterRegistry = new MeterRegistry(meterRepository);
 *
 * const meteringService = new MeteringService({
 *   meterRegistry,
 *   usageStorage,
 *   idempotencyManager,
 *   eventBus,
 * });
 *
 * // 데코레이터용 서비스 설정
 * setMeteringService(meteringService);
 * ```
 */

// ==================== Core Decorators ====================

/**
 * Meter 클래스 데코레이터의 메타데이터 타입입니다.
 *
 * @description `@Meter` 데코레이터로 클래스에 정의된 Meter의 메타데이터를 나타냅니다.
 */
export type { MeterMetadata, MeterOptions } from "./libs/decorators/Meter";

/**
 * Meter 클래스 데코레이터와 메타데이터 조회 헬퍼입니다.
 *
 * @description 클래스에 Meter 정의를 추가하고 메타데이터를 조회하는 기능을 제공합니다.
 *
 * @example
 * ```typescript
 * // 데코레이터로 Meter 정의
 * @Meter({
 *   meterId: 'api_calls',
 *   type: 'COUNT',
 *   quota: 10000,
 * })
 * class ApiController {
 *   @Metered({ meterId: 'api_calls' })
 *   async handleRequest() {
 *     // 자동으로 사용량 기록
 *   }
 * }
 *
 * // 메타데이터 조회
 * const metadata = getMeterMetadata(ApiController);
 * ```
 */
export {
  getMeterMetadata,
  hasMeterMetadata,
  METER_METADATA_KEY,
  Meter,
} from "./libs/decorators/Meter";

/**
 * Metered 메서드 데코레이터와 서비스 바인딩 헬퍼입니다.
 *
 * @description 메서드 호출 시 자동으로 사용량을 기록하는 데코레이터와 서비스 관리 기능을 제공합니다.
 *
 * @example
 * ```typescript
 * // 데코레이터 사용
 * class ApiService {
 *   @Metered({ meterId: 'api_calls' })
 *   async handleRequest(req: Request): Promise<Response> {
 *     return { status: 200 };
 *   }
 *
 *   // 커스텀 value 추출
 *   @Metered({
 *     meterId: 'data_transfer',
 *     valueExtractor: (args, result) => result.size,
 *   })
 *   async uploadFile(file: Buffer): Promise<{ size: number }> {
 *     return { size: file.length };
 *   }
 * }
 *
 * // 서비스 설정
 * setMeteringService(meteringService);
 * const service = getMeteringService();
 * ```
 */
export {
  clearMeteringService,
  getMeteredMetadata,
  getMeteringService,
  METERED_METADATA_KEY,
  Metered,
  runWithMeteringService,
  setMeteringService,
} from "./libs/decorators/Metered";

// ==================== Events ====================

/**
 * quota 초과 시 발행되는 도메인 이벤트입니다.
 *
 * @description 테넌트의 사용량이 설정된 quota를 초과했을 때 발행되는 이벤트입니다.
 *
 * @example
 * ```typescript
 * eventBus.publish(new QuotaExceededEvent({
 *   tenantId: 'tenant-123',
 *   meterId: 'api_calls',
 *   currentUsage: 10000,
 *   quota: 10000,
 *   timestamp: new Date(),
 * }));
 * ```
 */
export { QuotaExceededEvent } from "./libs/events/QuotaExceededEvent";

/**
 * 사용량 기록 시 발행되는 도메인 이벤트입니다.
 *
 * @description 사용량이 성공적으로 기록되었을 때 발행되는 이벤트입니다.
 *
 * @example
 * ```typescript
 * eventBus.publish(new UsageRecordedEvent({
 *   tenantId: 'tenant-123',
 *   meterId: 'api_calls',
 *   value: 1,
 *   recordedAt: new Date(),
 *   metadata: { endpoint: '/api/users' },
 * }));
 * ```
 */
export { UsageRecordedEvent } from "./libs/events/UsageRecordedEvent";

// ==================== Billable Usage Journal ====================

export { InMemoryBillableUsageJournal } from "./libs/BillableUsageJournal";
export { RedisBillableUsageJournal } from "./libs/RedisBillableUsageJournal";
export type {
  BillableUsageAppendResult,
  BillableUsageClaim,
  BillableUsageClaimOptions,
  BillableUsageDeliveryState,
  BillableUsageEvent,
  BillableUsageFailure,
  BillableUsageJournal,
  BillableUsageJournalDiagnostics,
  BillableUsageJournalEntry,
} from "./libs/BillableUsageJournal";

// ==================== Core Services ====================

/**
 * 중복 기록 방지를 위한 idempotency 관리자입니다.
 *
 * @description 처리 전에는 기본 30초의 lease를 획득하고, 작업 커밋 후 현재 claim으로 완료한 key만 기본 24시간 보관합니다.
 * checkAndMark 또는 beginProcessing이 반환한 claim을 completeProcessing이나 abortProcessing에 전달합니다.
 */
export { IdempotencyManager } from "./libs/IdempotencyManager";
export type {
  IdempotencyClaim,
  MeteringProcessingClaim,
  PendingMeteringDelivery,
} from "./libs/IdempotencyManager";

/**
 * MeteringService 생성 옵션 타입입니다.
 *
 * @description MeteringService 인스턴스 생성 시 필요한 의존성들을 정의합니다.
 */
export type { MeteringServiceOptions } from "./libs/MeteringService";

/**
 * 사용량 기록과 조회를 담당하는 핵심 서비스입니다.
 *
 * @description 사용량 기록, 조회, quota 체크 등 Metering의 핵심 기능을 제공하는 서비스 클래스입니다.
 *
 * @example
 * ```typescript
 * const service = new MeteringService({
 *   meterRegistry,
 *   usageStorage,
 *   idempotencyManager,
 *   eventBus, // optional
 * });
 *
 * // 사용량 기록
 * const aiTokens = defineMeter({
 *   key: 'ai.tokens',
 *   aggregation: 'SUM',
 *   unit: 'token',
 *   dimensions: { model: dimension.enum(['gpt-5', 'gpt-5-mini']) },
 *   billing: 'required',
 * });
 * const typedRecord = await service.record(aiTokens, {
 *   tenantId: 'tenant-123',
 *   eventId: requestId,
 *   value: usage.totalTokens,
 *   dimensions: { model },
 * });
 *
 * // string 기반 호환성 경로
 * const record = await service.record({
 *   tenantId: 'tenant-123',
 *   meterId: 'api_calls',
 *   value: 1,
 *   metadata: { endpoint: '/api/users' },
 * });
 *
 * // 사용량 조회
 * const usage = await service.getUsage({
 *   tenantId: 'tenant-123',
 *   meterId: 'api_calls',
 *   period: 'billing_cycle',
 * });
 * ```
 */
export { MeteringService } from "./libs/MeteringService";

/**
 * Definition-first meter helpers and deterministic meter descriptors.
 *
 * @example
 * ```typescript
 * const requests = defineMeter({
 *   key: 'api.requests',
 *   aggregation: 'COUNT',
 *   unit: 'request',
 *   dimensions: {
 *     region: dimension.enum(['apac', 'emea']),
 *   },
 * });
 * ```
 */
export { defineMeter, dimension } from "./libs/MeterRef";

/**
 * Meter 정의를 조회하고 등록하는 레지스트리입니다.
 *
 * @description 애플리케이션의 모든 Meter 정의를 관리하는 레지스트리입니다. 데코레이터로 정의된 Meter들을 로드하고 조회/등록 기능을 제공합니다.
 *
 * @example
 * ```typescript
 * const registry = new MeterRegistry(meterRepository);
 *
 * // 데코레이터로 정의된 모든 Meter 로드
 * await registry.loadAll();
 *
 * // Meter 조회
 * const meter = await registry.get('tenant-123', 'api_calls');
 *
 * // 새 Meter 등록
 * await registry.register({
 *   tenantId: 'tenant-123',
 *   meterId: 'storage_bytes',
 *   type: 'COUNT',
 *   quota: 1000000,
 * });
 * ```
 */
export { MeterRegistry } from "./libs/MeterRegistry";

// ==================== Repository Interface ====================

/**
 * 커스텀 Meter 저장소 구현을 위한 저장소 계약입니다.
 *
 * @description 사용자가 직접 Meter 정의를 영구 저장하기 위해 구현해야 하는 인터페이스입니다.
 *
 * @example
 * ```typescript
 * class PostgresMeterRepository implements MeterRepository {
 *   readonly replayContract = "idempotent" as const;
 *   async findByMeterIdAndTenant(meterId: string, tenantId: string) {
 *     return db.query(
 *       'SELECT * FROM meters WHERE meter_id = $1 AND tenant_id = $2',
 *       [meterId, tenantId]
 *     );
 *   }
 *
 *   async save(meter: MeterRegistrationOptions) {
 *     return db.insert('meters', meter);
 *   }
 *
 *   async findAll() {
 *     return db.query('SELECT * FROM meters');
 *   }
 *
 *   async findByTenant(tenantId: string) {
 *     return db.query('SELECT * FROM meters WHERE tenant_id = $1', [tenantId]);
 *   }
 *
 *   // Enforce durable uniqueness on (tenantId, meterId, idempotencyKey).
 *   async saveUsageRecords(records: UsageRecord[]) {
 *     for (const record of records) {
 *       await db.query(
 *         `INSERT INTO usage_records (id, tenant_id, meter_id, value, timestamp, idempotency_key)
 *          VALUES ($1, $2, $3, $4, $5, $6)
 *          ON CONFLICT (tenant_id, meter_id, idempotency_key) DO NOTHING`,
 *         [record.id, record.tenantId, record.meterId, record.value, record.timestamp, record.idempotencyKey]
 *       );
 *     }
 *   }
 * }
 * ```
 */
export { MeterRepository } from "./libs/MeterRepository";

// ==================== Problems ====================

export { AtomicQuotaNotSupportedProblem } from "./libs/problems/AtomicQuotaNotSupportedProblem";
export { BillableUsageJournalRequiredProblem } from "./libs/problems/BillableUsageJournalRequiredProblem";
/**
 * 중복 사용량 기록 시 발생하는 문제 타입입니다.
 *
 * @description 동일한 idempotency key로 이미 기록된 요청이 다시 시도된 경우 발생합니다. HTTP 409 Conflict 응답에 해당합니다.
 *
 * @example
 * ```typescript
 * throw new DuplicateRecordProblem('이미 기록된 사용량입니다', 'unique-key-123');
 * ```
 */
export { DuplicateRecordProblem } from "./libs/problems/DuplicateRecordProblem";
export { InvalidMeterDimensionProblem } from "./libs/problems/InvalidMeterDimensionProblem";
export { MeteringTransitionProblem } from "./libs/problems/MeteringTransitionProblem";

/**
 * 등록되지 않은 Meter를 사용할 때 발생하는 문제 타입입니다.
 *
 * @description 존재하지 않는 Meter를 참조하려는 경우 발생합니다. HTTP 404 Not Found 응답에 해당합니다.
 *
 * @example
 * ```typescript
 * throw new InvalidMeterProblem('api_calls', 'tenant-123');
 * ```
 */
export { InvalidMeterProblem } from "./libs/problems/InvalidMeterProblem";
export { InvalidUsageEnvelopeProblem } from "./libs/problems/InvalidUsageEnvelopeProblem";
export { InvalidUsageQueryProblem } from "./libs/problems/InvalidUsageQueryProblem";
export { InvalidUsageValueProblem } from "./libs/problems/InvalidUsageValueProblem";

/**
 * quota 초과 시 발생하는 문제 타입입니다.
 *
 * @description 테넌트의 사용량이 설정된 quota를 초과한 경우 발생합니다. HTTP 403 Forbidden 응답에 해당합니다.
 *
 * @example
 * ```typescript
 * throw new QuotaExceededProblem('api_calls', 10000, 10500);
 * ```
 */
export { QuotaExceededProblem } from "./libs/problems/QuotaExceededProblem";

/**
 * Redis 연동 중 발생하는 문제 타입입니다.
 *
 * @description Redis 연결 실패 또는 운영 중 오류가 발생한 경우 사용됩니다. HTTP 500 Internal Server Error 응답에 해당합니다.
 *
 * @example
 * ```typescript
 * try {
 *   await redisClient.set(key, value);
 * } catch (error) {
 *   throw new RedisProblem('Redis 연결 실패', error);
 * }
 * ```
 */
export { RedisProblem } from "./libs/problems/RedisProblem";

// ==================== Quota Management ====================

/**
 * QuotaManager 동작에 사용되는 옵션 및 결과 타입입니다.
 *
 * @description Quota 검증 및 기록 작업의 옵션과 결과를 정의합니다.
 */
export type {
  QuotaCheckAndRecordOptions,
  QuotaCheckAndRecordResult,
  QuotaManagerOptions,
} from "./libs/QuotaManager";

/**
 * quota 검증과 기록을 담당하는 관리자입니다.
 *
 * @description Quota 확인 및 사용량 기록을 원자적으로 수행하는 관리자입니다. Redis Lua 스크립트를 사용하여 race condition을 방지합니다.
 *
 * @example
 * ```typescript
 * const manager = new QuotaManager(usageStorage, meterRegistry);
 *
 * // 원자적 quota 체크 및 기록
 * const result = await manager.checkAndRecord({
 *   tenantId: 'tenant-123',
 *   meterId: 'api_calls',
 *   value: 1,
 * });
 *
 * if (!result.allowed) {
 *   throw new QuotaExceededProblem('api_calls', result.quota, result.currentUsage);
 * }
 * ```
 */
export { QuotaManager } from "./libs/QuotaManager";

// ==================== Storage ====================

/**
 * Redis 기반 저장소 구현에 필요한 클라이언트 계약입니다.
 *
 * @description UsageStorage에서 필요로 하는 최소한의 Redis 클라이언트 인터페이스입니다. ioredis, upstash 등 Redis 호환 라이브러리를 어댑터로 사용할 수 있습니다.
 *
 * @example
 * ```typescript
 * import type { RedisClient } from '@croco/metering-core';
 * import { createUpstashRedisClientFromEnv } from '@croco/metering-upstash';
 *
 * const client: RedisClient = createUpstashRedisClientFromEnv({
 *   UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
 *   UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
 * });
 * ```
 */
export type { RedisClient } from "./libs/RedisClient";

/**
 * Redis에 사용량을 기록하는 저장소 구현체입니다.
 *
 * @description Redis를 사용하여 실시간 사용량을 저장하고 조회하는 Storage 구현체입니다. Sorted Set을 사용하여 시간대별 사용량을 효율적으로 관리합니다.
 *
 * @example
 * ```typescript
 * const storage = new RedisUsageStorage(redisClient);
 *
 * // 사용량 기록
 * await storage.record('tenant-123', 'api_calls', Date.now(), 1);
 *
 * // 사용량 조회
 * const usage = await storage.getUsage(
 *   'tenant-123',
 *   'api_calls',
 *   startTime,
 *   endTime
 * );
 *
 * // 원자적 quota 체크 및 기록
 * const result = await storage.checkAndRecordAtomic({
 *   tenantId: 'tenant-123',
 *   meterId: 'api_calls',
 *   quota: 10000,
 *   value: 1,
 *   timestamp: Date.now(),
 * });
 * ```
 */
export { RedisUsageStorage } from "./libs/RedisUsageStorage";

/**
 * metering-core 전반에서 사용하는 기본 도메인 타입입니다.
 *
 * @description Meter 정의, 사용량 기록, 집계 기간 등 core 패키지 전반에서 사용하는 타입들을 내보냅니다.
 */
export type {
  AggregationPeriod,
  FlushResult,
  MeterDefinition,
  MeterRegistrationOptions,
  MeterType,
  RecordOptions,
  UsageQueryOptions,
  UsageRecord,
} from "./libs/types";

// ==================== Aggregation ====================
/**
 * UsageAggregator 생성 옵션 타입입니다.
 *
 * @description UsageAggregator 인스턴스 생성 시 필요한 설정을 정의합니다.
 */
export type { UsageAggregatorOptions } from "./libs/UsageAggregator";
/**
 * 사용량 집계와 배치 플러시를 담당하는 집계기입니다.
 *
 * @description Redis의 사용량을 DB로 배치 저장하는 집계기입니다. 장기 보관 및 과금 시스템 연동을 위해 주기적으로 flush를 수행합니다.
 *
 * @example
 * ```typescript
 * const aggregator = new UsageAggregator(usageStorage, meterRepository);
 *
 * // 특정 meter의 사용량 flush
 * const result = await aggregator.flushUsageToDB('tenant-123', 'api_calls');
 *
 * // 테넌트 전체 flush
 * const tenantResult = await aggregator.flushAllForTenant('tenant-123');
 * ```
 */
export { UsageAggregator } from "./libs/UsageAggregator";
/**
 * 사용량 저장소의 원자적 quota 체크 계약과 저장소 인터페이스입니다.
 *
 * @description 실시간 사용량 저장소의 추상 인터페이스와 원자적 quota 체크 옵션을 정의합니다. Redis 외에도 다른 저장소로 구현할 수 있습니다.
 */
export type {
  AtomicQuotaCheckOptions,
  AtomicQuotaCheckResult,
  UsageStorage,
} from "./libs/UsageStorage";
export type { MeteredMetadata, MeteredOptions, MeteredRefOptions } from "./libs/decorators/Metered";
export type {
  CountMeterRef,
  EnumDimension,
  MeterAggregation,
  MeterBillingIntent,
  MeterDefinitionOptions,
  MeterDimensionSchema,
  MeterDimensionValue,
  MeterRecordInput,
  MeterRef,
  NonEmptyMeterDimensionValues,
} from "./libs/MeterRef";

export { UsageFlushConfigurationProblem } from "./libs/problems/UsageFlushConfigurationProblem";
