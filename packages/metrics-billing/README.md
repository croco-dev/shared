# @croco/metrics-billing

Billing 도메인 이벤트를 Metrics 계산으로 연결하는 파이프라인 패키지입니다.

## 설치

```bash
pnpm add @croco/metrics-billing
```

## 개요

이 패키지는 `@croco/billing-core`에서 발생하는 도메인 이벤트를 수신하여 `@croco/metrics-core`의 메트릭 계산 엔진으로 전달합니다.

### 지원하는 이벤트

| 이벤트                      | 설명           | MRR Movement                                      |
| --------------------------- | -------------- | ------------------------------------------------- |
| `OrderPaidEvent`            | 주문 결제 완료 | 결제 사유에 따라 `new`, `reactivation`, 또는 없음 |
| `PlanChangedEvent`          | 플랜 변경      | `expansion` 또는 `contraction`                    |
| `SubscriptionCanceledEvent` | 구독 취소      | 실제 취소 시 `churned`, 기간 말 예약 시 없음      |

## 사용법

```typescript
import { BillingEventHandler } from "@croco/metrics-billing";
import { TimescaleMetricsStore } from "@croco/metrics-core";
import { Container } from "@croco/framework-context";

const metricsRepository = new TimescaleMetricsStore(db);
const handler = new BillingEventHandler(planRegistry, billingStore, metricsRepository);

await eventBus.publish(
  new OrderPaidEvent("tenant-1", "order-1", 2900, "USD", "subscription_create"),
);
```

### DI 컨테이너 등록

```typescript
import { Container } from "@croco/framework-context";
import { BillingEventHandler } from "@croco/metrics-billing";

Container.register(BillingEventHandler, {
  planRegistry: Container.resolve(PlanRegistry),
  billingStore: Container.resolve(BillingStore),
  metricsRepository: Container.resolve(MetricsRepository),
});
```

## MRR 변동 계산

### OrderPaidEvent

- `subscription_create`: `new` MRR 기록
- `subscription_reactivation`: `reactivation` MRR 기록
- `subscription_cycle`: 갱신 결제이므로 MRR movement를 기록하지 않음
- `subscription_update`, `one_time`: 활성 구독 MRR을 새로 만들지 않으므로 movement를 기록하지 않음
- 연간 플랜: 월별 MRR로 정규화 (amount / 12)

### PlanChangedEvent

- 업그레이드: `expansion` MRR 기록 (차액)
- 다운그레이드: `contraction` MRR 기록 (차액)
- 동일 금액: `unchanged` (0)

### SubscriptionCanceledEvent

- `cancelAtPeriodEnd: false`: `churned` MRR 기록
- `cancelAtPeriodEnd: true`: 구독이 활성 상태이므로 MRR movement를 기록하지 않음
- 이벤트의 `planVersionRef`로 취소 시점에 고정된 플랜 버전을 조회합니다. 즉시 취소로 구독이나 계정이 삭제되어도 해당 버전의 금액으로 집계합니다.
- `BillingService`와 Polar 이벤트 매퍼는 취소 이벤트에 `planVersionRef`를 포함합니다. 이전 버전의 이벤트처럼 이 값이 없으면 기존 구독에서 플랜 버전을 조회합니다.

## 멱등성

이벤트 키를 기반으로 멱등성을 보장합니다:

```
eventKey = `${eventName}_${event.eventId}`
```

동일한 이벤트 키로 중복 호출되면 TimescaleMetricsStore의 `ON CONFLICT DO NOTHING`이 처리합니다.
서로 다른 billing event는 같은 millisecond에 발생해도 `DomainEvent.eventId`가 다르므로
별도 metric으로 기록됩니다.

이전 버전은 `${eventName}_${timestamp.getTime()}` 형식의 timestamp 기반 키를 사용했습니다.
`BillingEventHandler`는 primary key로 `eventId` 기반 키를 전달하고, timestamp 기반 키를
compatibility dedupe alias로 함께 전달합니다. TimescaleMetricsStore는 alias가 이미 저장된
row를 발견하면 새 primary key insert를 건너뛰어 배포 전후 replay가 중복 MRR을 만들지 않게 합니다.

## Failure semantics

billing 이벤트가 metric으로 기록되지 못하는 경우를 성공처럼 숨기지 않습니다.
`BillingEventHandler`는 필요한 account, subscription, plan evidence가 없으면
`BillingMetricDroppedProblem`을 throw합니다. 취소 이벤트에 `planVersionRef`가 있으면 account나 subscription 조회는 필요하지 않지만, 해당 플랜 버전은 유지되어야 합니다. repository 기록이 실패하면
`BillingMetricRecordingProblem`을 throw합니다.

| Problem                         | Code                               | Recovery                                                                                                                        |
| ------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `BillingMetricDroppedProblem`   | `metrics-billing/metric-dropped`   | `extensions.reason`, `tenantId`, `resourceId`, `eventKey`로 누락된 billing state를 복구한 뒤 같은 billing event를 재처리합니다. |
| `BillingMetricRecordingProblem` | `metrics-billing/recording-failed` | metrics repository 장애를 복구한 뒤 `eventKey` 기반으로 같은 이벤트를 재시도합니다.                                             |

문제 extensions에는 raw billing payload나 secret이 아니라 event name, tenant id, idempotency
event key, drop reason, resource id만 포함됩니다.

## Dependencies

- `@croco/billing-core` - Billing 도메인 이벤트
- `@croco/events-core` - EventHandler 인터페이스
- `@croco/metrics-core` - Metrics 계산 및 저장
- `@croco/problems-core` - dropped/recording failure Problem
