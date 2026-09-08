# @croco/customer-health-drizzle

`@croco/customer-health-core`용 Drizzle 구현체입니다.

## 설치

```bash
pnpm add @croco/customer-health-drizzle @croco/customer-health-core drizzle-orm
```

## 사용법

```typescript
import {
  addHealthEventIntents,
  BillingSignalProvider,
  DrizzleHealthScoreStore,
  DrizzleHealthSignalRegistry,
  MeteringSignalProvider,
} from "@croco/customer-health-drizzle";

await addHealthEventIntents(db);
const scoreStore = new DrizzleHealthScoreStore(db);
const usageProvider = new MeteringSignalProvider(usageStorage);
const billingProvider = new BillingSignalProvider(subscriptionStorage);
const registry = new DrizzleHealthSignalRegistry(usageProvider, billingProvider);

await scoreStore.saveTransition(
  {
    tenantId: "tenant-1",
    overallScore: 85,
    status: "healthy",
    categoryScores: { usage: 90, business: 80, engagement: 85 },
    signals: [],
    trend: "stable",
    calculatedAt: new Date(),
  },
  null,
  [],
);

const latest = await scoreStore.findLatest("tenant-1");
const providers = registry.getProviders();
```

기존 점수 행의 순서를 안전하게 초기화하려면 마이그레이션 동안 기존 writer를 중지한 뒤
`addHealthEventIntents(db)`를 실행하세요. 이후 저장소는 DB가 부여한 단조 증가 transition sequence로
최신 점수를 판별합니다.

기존 PostgreSQL 배포에서는 소수 건강 점수를 저장하기 전에
`widenHealthScorePrecisionPostgres`를 실행해야 합니다. 이 migration은 현재 점수와 이전 점수
컬럼을 한 transaction에서 `DOUBLE PRECISION`으로 변환하며 기존 정수 값은 그대로 유지합니다.

## 기존 점수 테이블의 기본 키와 인덱스 적용

스키마 선언 변경만으로 기존 DB가 변경되지는 않습니다. `transition_sequence`가 없는 배포는
먼저 위의 `addHealthEventIntents(db)` 마이그레이션을 완료하세요. 기본 키와 아래 인덱스가 없는
기존 테이블에는 다음 SQL을 한 번 적용하세요. Drizzle 마이그레이션으로 같은 변경을 적용했다면
중복 실행하지 마세요.

```sql
BEGIN;
ALTER TABLE tenant_health_scores
  ADD CONSTRAINT tenant_health_scores_pkey PRIMARY KEY (transition_sequence);
CREATE INDEX tenant_health_scores_tenant_seq_idx
  ON tenant_health_scores (tenant_id, transition_sequence DESC);
CREATE INDEX tenant_health_scores_tenant_calc_idx
  ON tenant_health_scores (tenant_id, calculated_at DESC);
COMMIT;
```

이 작업은 테이블 잠금을 사용하므로 쓰기를 중지할 수 있는 유지보수 시간에 실행하세요.
중복된 순번이나 NULL이 있으면 기본 키 생성이 실패합니다. 데이터를 확인하고 원인을 해결한 후
다시 실행하세요. 순번 인덱스는 최신 점수·이력 조회에, 시간 인덱스는 기간별 조회에 사용될 수
있으며 실제 실행 계획은 PostgreSQL 통계와 조회 범위에 따라 달라집니다.

## API 레퍼런스

### `DrizzleHealthScoreStore`

- `saveTransition(score, previous, eventIntents)`, 기대한 이전 점수를 확인하고 건강 점수와 이벤트 의도를 한 트랜잭션에 저장합니다.
- `listPendingEventIntents(tenantId, limit)`, 미발행 이벤트 의도를 조회합니다.
- `markEventIntentPublished(eventId)`, 성공적으로 발행한 의도를 완료 처리합니다.
- `findLatest(tenantId)`, 최신 건강 점수를 조회합니다.
- `findHistory(tenantId, limit)`, 최근 점수 이력을 조회합니다.
- `findHistoryByPeriod(tenantId, period, startDate, endDate)`, 기간별 이력을 조회합니다.

### 신호 제공자

- `BillingSignalProvider`, 구독 상태를 business 신호로 변환합니다.
- `MeteringSignalProvider`, UTC 월 시작부터 다음 달 시작 직전까지의 반개방 구간으로 사용량을 조회해 usage 신호로
  변환합니다. 전체 및 기능별 `usage`는 유한한 `0` 이상, `limit`는 유한한 `0` 초과 값이어야 하며, 위반하면
  `InvalidMeteringInputProblem`으로 실패합니다.
- `DrizzleHealthSignalRegistry`, 기본 신호 제공자 목록을 반환합니다.

### 타입과 스키마

- `SubscriptionStatus`, `SubscriptionData`, `SubscriptionStorage`, 구독 신호 타입입니다.
- `UsageData`, `UsageStorage`, 사용량 신호 타입입니다. `UsageStorage.getUsage`의 시작 시각은 포함하고 종료 시각은 제외합니다.
- `DRIZZLE_TOKEN`, 건강 점수 저장소용 DB 토큰입니다.
- `SUBSCRIPTION_STORAGE_TOKEN`, `USAGE_STORAGE_TOKEN`, 보조 저장소 토큰입니다.
- `tenantHealthScores`, 건강 점수 스키마입니다.
- `tenantHealthEventIntents`, 복구 가능한 전이 이벤트 의도 스키마입니다.
- `addHealthEventIntents`, 운영 전 이벤트 의도 테이블과 인덱스를 생성하는 마이그레이션입니다.
- `widenHealthScorePrecisionPostgres`, 기존 PostgreSQL 점수 컬럼을 소수 지원 타입으로
  변환합니다.
