# @croco/metering-core

SaaS 사용량 기록, quota 검증, idempotency 처리를 제공하는 미터링 코어 패키지입니다.

## 설치

```bash
pnpm add @croco/metering-core
```

## 사용법

새 코드에서는 meter 정의와 billable usage envelope를 타입으로 연결합니다.

```ts
import { defineMeter, dimension, type MeteringService } from "@croco/metering-core";

const aiTokens = defineMeter({
  key: "ai.tokens",
  aggregation: "SUM",
  unit: "token",
  dimensions: {
    model: dimension.enum(["gpt-5", "gpt-5-mini"]),
  },
  billing: "required",
});

declare const requestId: string;
declare const usage: { totalTokens: number };
declare const model: "gpt-5" | "gpt-5-mini";
declare const meteringService: MeteringService;

await meteringService.record(aiTokens, {
  tenantId: "tenant-123",
  eventId: requestId,
  value: usage.totalTokens,
  dimensions: { model },
  metadata: { route: "/generate" },
});
```

`billing: "required"` meter는 비어 있지 않은 `eventId`를 타입과 런타임에서 요구합니다. dimension은 정의된
key와 enum 값만 허용되며 provider billing dimension과 자유 형식 application `metadata`는 별도 필드로
유지됩니다. `defineMeter()`가 반환하는 descriptor는 함수 값을 포함하지 않고 결정적으로 직렬화됩니다.
모든 meter의 `value`는 모든 지원 storage adapter가 보존할 수 있는 1 이상 `Number.MAX_SAFE_INTEGER` 이하의 정수여야
합니다. 소수, 0, 음수, 비유한 수, 이 범위를 벗어난 값은 idempotency key를 획득하거나 usage를 저장하기
전에 `InvalidUsageValueProblem`으로 거부됩니다.

## Durable billable usage delivery

`billing: "required"` meter를 등록하거나 기록하려면 `durability: "persistent"`를 선언하는
`BillableUsageJournal` 구현을 `MeterRegistry`에 제공해야 합니다. `MeteringService`도 같은 registry가 소유한 journal만
사용하므로 bootstrap 검증과 worker backlog가 서로 다른 저장소를 가리킬 수 없습니다. journal은 provider 호출보다
먼저 stable `eventId`의 intent를 append하므로 request 경로와 provider 가용성이 분리됩니다. 같은 `eventId`와 같은
envelope를 다시 append하면 duplicate success이고, 다른 envelope는 transition conflict입니다.
Append된 pending intent는 local usage commit이 성공해 `markDeliverable()`이 저장되기 전에는 worker가 claim할 수
없습니다. commit 이후 중단된 호출은 같은 `eventId`를 replay해 activation을 idempotent하게 완료할 수 있습니다.

```ts
declare const journal: BillableUsageJournal;

const registry = new MeterRegistry(repository, 60_000, journal);
await registry.loadAll();

const metering = new MeteringService({
  meterRegistry: registry,
  usageStorage,
  idempotencyManager,
  eventBus,
});
```

Provider delivery worker는 `claimNext()`로 lease를 얻고, 반환된 owner와 fencing token을 그대로 사용해
`markAccepted()`, `markRetryableFailed()`, `markTerminalFailed()` 중 하나로 종료해야 합니다. lease가 만료되면 다른
worker가 더 큰 fencing token으로 replay할 수 있으며 이전 owner의 갱신은 거부됩니다. accepted 상태가 journal에
저장된 뒤에만 backlog에서 제거됩니다. `getDiagnostics()`는 backlog count, oldest pending age, 누적 retry count,
terminal failure count를 반환합니다. Redis adapter의 lease와 fence 검증은 worker 시계가 아니라 Redis server time을
사용하고, 진단은 전체 event history를 scan하지 않는 backlog index와 누적 counter로 계산됩니다.

`InMemoryBillableUsageJournal`은 상태 머신 검증과 로컬 테스트용 volatile reference adapter입니다. production에서
사용하면 bootstrap이 거부되며, 영속 저장소 adapter는 각 append와 claim transition을 원자적으로 구현해야 합니다.

기존 string 기반 API는 호환성 경로로 계속 지원됩니다.

```ts
import {
  IdempotencyManager,
  MeterRegistry,
  MeteringService,
  RedisUsageStorage,
  setMeteringService,
} from "@croco/metering-core";

const usageStorage = new RedisUsageStorage(redisClient);
const idempotencyManager = new IdempotencyManager(redisClient);
const meterRegistry = new MeterRegistry(meterRepository);

const meteringService = new MeteringService({
  meterRegistry,
  usageStorage,
  idempotencyManager,
  eventBus,
});

setMeteringService(meteringService);

await meteringService.record({
  tenantId: "tenant-123",
  meterId: "api_calls",
  value: 1,
});
```

```ts
import { defineMeter, Meter, Metered } from "@croco/metering-core";

const apiCalls = defineMeter({
  key: "api.calls",
  aggregation: "COUNT",
  unit: "request",
});

@Meter({ meterId: "api.calls", type: "COUNT", quota: 10000 })
class ApiController {
  @Metered({ meter: apiCalls })
  async listUsers(): Promise<void> {}
}
```

## API 레퍼런스

### 핵심 클래스

- `MeteringService`, 사용량 기록과 조회를 담당합니다.
- `MeterRegistry`, 테넌트별 meter 정의를 조회하고 캐시합니다.
- `QuotaManager`, quota 확인과 기록을 원자적으로 처리합니다.
- `IdempotencyManager`, 중복 기록을 방지합니다.
- `RedisUsageStorage`, Redis 기반 실시간 사용량 저장소입니다.
- 명시적인 usage 조회 범위의 `startDate`와 `endDate`는 모두 포함되며, 월 경계를 넘는 billing cycle 조회는
  범위와 겹치는 모든 UTC 월 파티션을 집계합니다. 두 날짜는 함께 제공해야 하며 한 번의 조회는 최대 1,200개
  월 파티션으로 제한됩니다.
- `UsageAggregator`, Redis 데이터를 영구 저장소로 flush 합니다.

### 데코레이터

- `@Meter`, 클래스에 meter 정의를 선언합니다.
- `@Metered`, 메서드 호출 시 사용량을 자동 기록합니다.
- `setMeteringService`, 데코레이터가 사용할 전역 서비스를 등록합니다.

### 주요 타입

- `RecordOptions`, 사용량 기록 입력입니다.
- `MeterRef`, definition-first meter descriptor입니다.
- `MeterRecordInput`, meter별 billable usage envelope 입력입니다.
- `UsageQueryOptions`, 기간별 사용량 조회 입력입니다.
- `MeterDefinition`, meter 정의입니다.
- `UsageRecord`, 기록된 사용량 엔트리입니다.
- `FlushResult`, 배치 flush 결과입니다.

### 이벤트와 문제 타입

- 이벤트: `UsageRecordedEvent`, `QuotaExceededEvent`
- core 문제 타입: `DuplicateRecordProblem`, `InvalidMeterDimensionProblem`, `InvalidMeterProblem`,
  `InvalidUsageEnvelopeProblem`, `InvalidUsageValueProblem`, `QuotaExceededProblem`, `RedisProblem`
- Drizzle adapter 문제 타입: `UsageEnvelopeConfigurationProblem`

## 구현 포인트

- 저장소는 `MeterRepository`, `UsageStorage`, `RedisClient` 계약을 구현해 연결합니다.
- `RedisUsageStorage.record()`는 usage member와 24시간 dedupe marker를 단일 Lua script로 기록하여 실패하거나 응답이 유실된 요청도 같은 idempotency key로 안전하게 재시도할 수 있습니다.
- 이 원자적 기록은 usage key와 dedupe key를 함께 실행하는 single-shard Redis를 요구합니다. 현재 key schema는 Redis Cluster hash-slot colocation을 제공하지 않습니다.
- quota 초과 시 `allowOverQuota` 설정에 따라 이벤트 발행 또는 Problem 예외가 발생합니다.
- billing, entitlements 같은 상위 패키지와 이벤트 기반으로 연결할 수 있습니다.
- 이벤트 발행 payload는 exclusive processing lease와 함께 저장됩니다. 발행 실패 후 동일한 idempotency
  key를 재시도하면 저장된 payload만 재개하므로 사용량을 다시 기록하지 않고, 이벤트는 동일한 event ID로
  다시 발행됩니다.
- `UsageStorage` 구현은 `replayContract: "idempotent"`를 선언하고 동일 idempotency key의 persistence
  재실행을 안전하게 처리해야 합니다. 이는 usage 저장 직후 프로세스가 중단되어 processing lease가 만료된
  경우의 복구 계약입니다.
- `RedisUsageStorage`와 `IdempotencyManager`는 `scriptKeyAccess: "multi-key"` capability를 선언한
  `RedisClient`가 필요합니다. 원자적 Lua 스크립트가 여러 logical key에 접근하므로 cross-slot script를
  거부하는 Redis Cluster deployment는 지원하지 않습니다. Standalone Redis와 제공되는 Upstash adapter는
  이 계약을 충족합니다.
- `RedisUsageStorage.resetBillingCycle(tenantId)`는 현재 billing cycle의 tenant usage key를 `KEYS` 대신 bounded `SCAN` batch로 삭제합니다.
- tenant-wide reset은 이미 삭제된 key를 다시 삭제하지 않는 idempotent 작업이며, batch 사이에 새로 기록된 현재 cycle usage는 다음 reset에서 정리될 수 있습니다.

### 직접 사용하는 idempotency lease

`checkAndMark()`는 이제 `boolean` 대신 `IdempotencyClaim | null`을 반환합니다. `null`은 같은 key가
처리 중이거나 완료되었다는 뜻입니다. `checkAndMarkOrThrow()`도 완료·중단에 사용할 claim을 반환합니다.
기존 호출자는 반환값을 보관하고 비즈니스 작업이 커밋된 뒤 `completeProcessing()`에 전달해야 합니다.
`beginProcessing()`과 `beginProcessingOrThrow()`도 같은 2단계 생명주기를 사용합니다.

획득 시에는 `IN_PROGRESS:<claim>`만 기록하며 기본 리스는 30초입니다. 생성자의 세 번째 인자로 리스를
밀리초 단위로 설정할 수 있고 Redis TTL은 초 단위로 올림합니다. 작업이 확실히 실패한 경우에는 같은 claim으로
`abortProcessing()`을 호출해 즉시 재시도할 수 있습니다. 프로세스가 중단되면 리스 만료 후 새 워커가 재시도합니다.
현재 claim으로 완료한 경우에만 완료 시점부터 기본 24시간 동안 `COMPLETED`를 보관하며, 이 기간은 생성자의
두 번째 인자로 설정합니다. 만료되거나 다른 워커가 재획득한 claim의 완료·중단 호출은 상태를 변경하지 않습니다.

이 리스는 비즈니스 저장소의 커밋과 원자적이지 않습니다. 커밋 직후 완료 마킹 전에 중단되거나 작업이 리스보다
길어지면 재실행될 수 있으므로, 비즈니스 작업도 같은 key로 중복 커밋을 방지해야 합니다. 예상 작업 시간에 맞춰
리스 길이를 설정하세요. 이미 저장된 구버전 완료 마커는 성공 여부를 판별할 근거가 없어 기존 TTL까지 유지됩니다.

### Redis key 마이그레이션

`IdempotencyManager`와 `RedisUsageStorage`는 tenant, meter, idempotency segment의 안전한 ASCII 문자는
그대로 두고 나머지 UTF-16 code unit을 고정 폭으로 인코딩한 `idem2:` 및 `usage2:` key를 사용합니다.
Lifecycle marker와 record dedupe marker는 각각 `idem2:lifecycle:`과 `idem2:record:`로 분리됩니다. 따라서
`:`, Unicode, glob 문자, 빈 문자열을 포함한 식별자도 서로 다른 tuple이면 서로 다른 Redis key를 생성하고,
서로 다른 idempotency state machine도 같은 key를 점유하지 않습니다.
Usage sorted set과 record dedupe marker는 한 Lua script에서 함께 기록되므로 첫 성공은 usage를 정확히 한 번
반영하고, 같은 idempotency key의 재시도는 두 번째 record를 만들지 않습니다.

이전 `idem:<tenant>:<meter>:<key>`와 `usage:<tenant>:<meter>:<period>` 형식은 segment 경계가
모호하므로 새 코드에서 읽거나 삭제하지 않습니다. 기존 deployment를 전환할 때는 다음 중 하나를 선택해야
합니다.

- billing cycle 경계에서 metering write를 중단하고, idempotency TTL(기본 24시간)이 지난 뒤 새 버전을
  배포해 새 cycle을 `usage2:`에서 시작합니다.
- cycle 중간에 전환해야 하면 write를 중단하고, authoritative tenant/meter mapping의 tuple을 legacy physical
  key 기준으로 먼저 그룹화합니다. 하나의 legacy key에 tuple 하나만 대응하는 singleton group만 해당 usage
  record를 `RedisUsageStorage`의 새 record 경로 또는 동등한 `usage2:` import 절차로 이관할 수 있습니다.
  tuple 여러 개가 같은 legacy key에 대응하는 collision group은 Redis sorted set member에 tenant/meter
  ownership이 없으므로 그 set 자체로는 분리할 수 없습니다. 독립적인 per-record/event ledger에서 소유권을
  복구하거나 수동 reconcile해야 하며, 같은 legacy set을 각 tuple에 복제하면 안 됩니다. 모호한 legacy key
  문자열만 역파싱해 이관하는 것도 안전하지 않습니다.
- idempotency TTL이 지나기 전에 재개하면 이미 처리된 요청이 새 namespace에서 다시 처리될 수 있으므로,
  해당 요청은 독립 request ledger로 reconcile해야 합니다. 안전한 drain 시간은 configured lifecycle TTL,
  24시간 record TTL, `isIdempotent()`에 전달한 custom TTL을 포함해 배포에서 사용한 가장 긴 TTL 이상입니다.

구버전과 신버전 인스턴스를 함께 운영하면 usage와 idempotency state가 두 namespace로 분리되어 quota와
dedupe 보장이 깨집니다. 모든 구버전 writer를 중지하고 migration을 검증한 뒤 신버전 writer를 시작하세요.

- 기존 Redis usage member에 소수, 0, 음수, 지원 범위를 벗어난 값이 있으면 조회와 quota 검사는 값을
  축소하지 않고 실패합니다. 운영자는 해당 record의 원본 과금 근거를 확인해 정수 minor unit으로
  재작성하거나 격리해야 합니다.

### Safe usage flush adapters

`UsageAggregator` rejects storage without `deleteUsageRecords` and repositories without
`readonly replayContract = "idempotent" as const` when constructed, before reading or saving usage.
Custom `MeterRepository` adapters must enforce persistent uniqueness on
`(tenantId, meterId, idempotencyKey)` in `saveUsageRecords`, including concurrent calls,
overlapping batches, partial writes and process restarts. Declare the contract only after
implementing this guarantee. `DrizzleMeterRepository` uses its unique index and conflict handling.

After a save or deletion failure, retry the flush normally. Already persisted records are ignored
by the repository, and deletion removes only the supplied records. `recordsFlushed` counts records
successfully processed by the flush, including records persisted by a previous attempt.
`UsageStorage.deleteUsageRecords` remains optional for storage used without an aggregator.
