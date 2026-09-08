# @croco/billing-polar

Polar 결제 플랫폼 연동 — checkout, webhook, 구독 관리

## 설치

```bash
pnpm add @croco/billing-polar
```

## 개요

Polar 결제 플랫폼을 `@croco/billing-core`와 통합하여 SaaS 구독 비즈니스를 구축합니다.

- **Checkout**: Polar checkout 세션 생성
- **Webhook**: 서명 검증, 멱등성, 이벤트 매핑
- **구독 관리**: 활성화/취소/재개, 고객 포털 URL

## 구성

```typescript
import { PolarConfig } from "@croco/billing-polar";

const config: PolarConfig = {
  accessToken: "polar-access-token",
  environment: "sandbox",
  webhookSecret: "polar-webhook-secret",
  organizationId: "org-123",
  checkoutRecovery: {
    ttlMs: 300_000,
    capacity: 1_000,
  },
};
```

### PolarConfig

| 필드                        | 타입                        | 필수 | 설명                                                         |
| --------------------------- | --------------------------- | ---- | ------------------------------------------------------------ |
| `accessToken`               | `string`                    | ✅   | Polar API 액세스 토큰                                        |
| `environment`               | `'sandbox' \| 'production'` | ✅   | Polar 환경                                                   |
| `webhookSecret`             | `string`                    | ✅   | 웹훅 서명 검증 시크릿                                        |
| `organizationId`            | `string`                    | ❌   | Polar 조직 ID                                                |
| `checkoutRecovery.ttlMs`    | `number`                    | ❌   | 모호한 checkout을 재조정하는 기간(ms, 기본값 `300000`)       |
| `checkoutRecovery.capacity` | `number`                    | ❌   | 프로세스별로 추적할 모호한 checkout의 최대 수(기본값 `1000`) |

복구 기간 안에서는 같은 operation key를 다시 생성하지 않고 provider checkout을 재조정합니다. TTL이
끝나거나 용량 때문에 축출되면 완료로 처리하지 않고 `warn` 진단을 남긴 뒤, 다음 요청에서 provider
metadata를 다시 조회한 후 일반 생성 흐름을 재개합니다.

### 환경 변수

운영 앱에서는 아래 환경 변수를 `PolarConfig`로 명시적으로 주입하는 방식을 권장합니다.

| 환경 변수               | 필수 | 설명                                                  |
| ----------------------- | ---- | ----------------------------------------------------- |
| `POLAR_ACCESS_TOKEN`    | ✅   | Polar API 액세스 토큰                                 |
| `POLAR_WEBHOOK_SECRET`  | ✅   | Polar webhook endpoint의 서명 검증 시크릿             |
| `POLAR_ENVIRONMENT`     | ❌   | `sandbox` 또는 `production` (기본 테스트는 `sandbox`) |
| `POLAR_ORGANIZATION_ID` | ❌   | live smoke에서 조직 읽기 검증을 수행할 때 필요        |

`accessToken`과 `webhookSecret`은 diagnostics, 로그, 테스트 출력에 원문으로 남기지 않습니다.

`webhookSecret`은 발급된 값을 그대로 전달합니다. 기존 Polar HMAC은 UTF-8 원문을 키로 사용합니다.
이 검증이 실패하고 `whsec_` 접두사가 있으면 Standard Webhooks의 Base64 키로도 검증합니다.
기존 시크릿도 같은 접두사를 사용할 수 있으므로 두 방식을 지원합니다.
[Polar 공식 호환성 안내](https://polar.sh/docs/guides/laravel)를 따르며, 두 검증 모두 실패하면
웹훅을 거부합니다. 접두사 없는 값은 Base64처럼 보여도 디코딩하지 않습니다.

## 사용법

### Checkout 생성

```typescript
import { Container } from "@croco/framework-context";
import { PolarBillingGateway } from "@croco/billing-polar";

const gateway = Container.get(PolarBillingGateway);

const checkout = await gateway.createCheckout({
  billingAccountId: "tenant-123",
  email: "user@example.com",
  productId: "prod-456",
  successUrl: "https://example.com/success",
  cancelUrl: "https://example.com/cancel",
  idempotencyKey: "checkout-order-123",
});
```

### 구독 관리

```typescript
await gateway.cancelSubscription("sub-789", false);
await gateway.resumeSubscription("sub-789");
const portalUrl = await gateway.getCustomerPortalUrl("cust-101");
```

### Durable usage delivery

`bindPolarUsageMeter()`는 typed Croco meter를 Polar event name, provider meter id, 그리고 value metadata
key에 연결합니다. `PolarUsageDeliveryWorker`는 `BillableUsageJournal`에서 bounded claim을 가져와 request
path 밖에서 전송하므로 `MeteringService.record()`가 Polar availability에 동기적으로 의존하지 않습니다.

```typescript
import { defineMeter, RedisBillableUsageJournal } from "@croco/metering-core";
import {
  bindPolarUsageMeter,
  PolarUsageBillingGateway,
  PolarUsageDeliveryWorker,
} from "@croco/billing-polar";

const tokens = defineMeter({
  key: "ai.tokens",
  aggregation: "SUM",
  unit: "token",
  billing: "required",
  dimensions: { model: { kind: "enum", values: ["gpt-5-mini"] } },
});

const usage = new PolarUsageBillingGateway(config, [
  bindPolarUsageMeter({
    meter: tokens,
    eventName: "ai_tokens_consumed",
    providerMeterId: process.env.POLAR_METER_ID_TOKENS ?? "",
    valueMetadataKey: "tokens",
  }),
]);

const worker = new PolarUsageDeliveryWorker(new RedisBillableUsageJournal(redis), usage, {
  ownerId: "usage-dispatcher-1",
  leaseDurationMs: 60_000,
  maxBatchSize: 25,
});
await worker.deliverNextBatch();
```

Croco `eventId` is sent as Polar `externalId`, so a replay receives an inserted or duplicate receipt without
increasing accepted usage twice. Polar exposes only aggregate counts per ingestion request; the gateway sends one
event per provider request so every journal claim has a deterministic receipt. Retryable rate-limit, 5xx, and
transport failures retain journal retry metadata; invalid mapping and schema failures remain terminal and inspectable.
Applications schedule the worker independently and must provide a persistent journal in production.

### 웹훅 처리

```typescript
import { PolarWebhookHandler } from "@croco/billing-polar";

const handler = new PolarWebhookHandler(config, {
  store: billingStore,
  eventPublisher: eventPublisher,
  planRegistry,
});

const result = await handler.handle(requestBody, requestHeaders);
```

웹훅 검증에는 Polar가 보낸 raw body와 signature header가 필요합니다. JSON으로 재직렬화한 body를
사용하면 서명 검증이 실패할 수 있습니다. 잘못된 서명 또는 구조적으로 잘못된 webhook payload는
`WebhookValidationProblem`으로 실패합니다. Polar SDK가 replay-style signature, 오래된 timestamp,
또는 clock-skew를 거부하면 Croco는 안정적인 `WEBHOOK_VALIDATION_FAILED` Problem code와 HTTP
400 status로 정규화하고, webhook secret/signature 값은 응답 detail에 노출하지 않습니다.
구독 이벤트의 Polar product/price 조합은 `PlanRegistry`의 게시된 버전과 정확히 일치해야 하며,
알 수 없는 조합을 포함해 구독 전이, 주문 저장, 이벤트 발행 또는 완료 기록에 실패하면
`WebhookProcessingProblem`을 throw합니다. HTTP 트랜스포트는 이를 500으로 응답하므로 Polar가
재전달할 수 있습니다. 원인 오류는 `cause`에 보존되며, 알 수 없는 조합의 원인 코드는
`billing/unknown-provider-plan-mapping`입니다. 호출자는 실패를 catch한 뒤 200으로 응답하지 않아야 합니다.
성공한 처리와 이미 완료된 이벤트의 재전달은 `{ success: true, eventId }`를 반환합니다.

## 웹훅 이벤트 타입

### 구독 이벤트

| 이벤트 타입             | 설명           |
| ----------------------- | -------------- |
| `subscription.created`  | 구독 생성      |
| `subscription.active`   | 구독 활성화    |
| `subscription.updated`  | 구독 업데이트  |
| `subscription.canceled` | 구독 취소      |
| `subscription.revoked`  | 구독 해지      |
| `subscription.past_due` | 결제 지연 전환 |

`subscription.updated`와 `subscription.past_due`가 같은 상태 전환을 알리면 구독별 past-due reservation을
원자적으로 선점합니다. 여러 인스턴스에서 겹쳐 처리해도 한 번만 발행하고, 발행 실패 시에는 재시도를 위해
reservation을 해제합니다. 구독이 past-due 상태를 벗어나면 reservation을 초기화하므로 이후의 새 연체
전환은 다시 발행됩니다.

### 주문 이벤트

| 이벤트 타입     | 설명                                                   |
| --------------- | ------------------------------------------------------ |
| `order.paid`    | 결제된 주문을 저장하고 `OrderPaidEvent` 발행           |
| `order.created` | delivery를 멱등 처리하지만 결제 주문으로 저장하지 않음 |
| `order.updated` | delivery를 멱등 처리하지만 결제 주문으로 저장하지 않음 |

`order.paid`의 공식 `billing_reason`은 `Order.reason`과 `OrderPaidEvent.reason`에 전달됩니다.
`subscription_create`는 구독 시작 결제, `subscription_cycle`은 정기 갱신,
`subscription_update`는 구독 변경 결제, `purchase`는 `one_time`으로 정규화됩니다.
Polar 주문 payload가 제공하지 않는 재활성화는 도착 순서나 로컬 상태로 추측하지 않습니다.
재활성화를 명시할 수 있는 provider는 `subscription_reactivation`을 사용해야 합니다.

### 기존 오분류 주문 복구

`@croco/billing-polar` 0.0.4 이하에서 `order.created` 또는 `order.updated` webhook을 처리했다면 결제
증거가 없는 주문이 저장되었을 수 있습니다. 기존 주문 레코드만으로는 어떤 Polar 이벤트가 저장을
만들었는지 판별할 수 없으므로, 배포 전에 `externalOrderId`를 Polar의 결제 완료 주문 또는 보존된
webhook 기록의 `order.paid` 이벤트와 대조해야 합니다. `order.paid` 증거가 없는 레코드는 매출,
invoice, LTV, entitlement 계산에서 제외하고 사용하는 `BillingStore` 백엔드에서 제거하거나
비결제 상태를 표현하는 별도 레코드로 이관하세요.

## 멱등성

Polar 웹훅은 `eventId`를 멱등성 키로 사용합니다:

- 같은 `eventId`는 한 번만 처리됩니다
- 동일한 `webhook-id`, timestamp, signature로 재전송된 delivery는 성공 응답을 유지하면서 도메인
  side effect를 반복하지 않습니다
- 진행 중인 이벤트는 메모리에서 추적하여 중복 실행 방지
- 저장소가 같은 `eventId` 예약에 대해 `WebhookAlreadyProcessedProblem`을 throw한 경우에만 이미
  처리된 delivery로 간주합니다
- 다른 unique constraint, SQLSTATE, 또는 generic duplicate 오류는 성공으로 확인되지 않으며
  재시도 가능한 `WebhookProcessingProblem`으로 유지됩니다
- 처리 실패 시 `failWebhook`으로 롤백 지원

## 스키마

### PolarSubscriptionData

```typescript
type PolarSubscriptionData = {
  id: string;
  status: "active" | "past_due" | "canceled" | "revoked" | "trialing";
  customer?: {
    externalId?: string | null;
    metadata?: Record<string, unknown> | null;
  };
  product?: {
    id?: string;
  };
  currentPeriodEnd?: Date | string | null;
  cancelAtPeriodEnd?: boolean | null;
};
```

### PolarOrderData

```typescript
type PolarOrderData = {
  id: string;
  amount?: number;
  currency?: string;
  createdAt?: Date | string | null;
  customer?: {
    externalId?: string | null;
    metadata?: Record<string, unknown> | null;
  };
};
```

## 재시도 정책

Polar API 호출에 자동 재시도 적용:

- **전략**: 지수 백오프
- **초기 간격**: 500ms
- **최대 간격**: 5초
- **최대 경과 시간**: 15초
- **재시도 코드**: 429, 500, 502, 503, 504

## Diagnostics / Readiness

`PolarBillingDiagnosticsProvider`는 설정 존재 여부와 선택적 readiness check 결과를
`@croco/diagnostics-core`의 `DiagnosticsProvider` 형태로 노출합니다.

```typescript
import { PolarBillingDiagnosticsProvider } from "@croco/billing-polar";

const provider = new PolarBillingDiagnosticsProvider(config);
const health = await provider.getHealth();
```

기본 diagnostics는 Polar에 네트워크 요청을 보내지 않습니다. live readiness가 필요하면
`readinessCheck`를 주입합니다. 반환되는 details는 token, secret, signature, password, api key 같은
민감한 키를 자동으로 redaction합니다.

## 에러 처리

```typescript
import {
  PolarCustomerNotFoundProblem,
  PolarMissingConfigProblem,
  PolarRetryableUpstreamProblem,
  PolarSubscriptionNotFoundProblem,
  PolarTerminalUpstreamProblem,
  PolarUsageCustomerNotFoundProblem,
  PolarValidationProblem,
  WebhookValidationProblem,
  WebhookProcessingProblem,
  BillingStatusMappingProblem,
} from "@croco/billing-polar";
```

| 에러                                | 코드                                          | 카테고리            | 설명                                 |
| ----------------------------------- | --------------------------------------------- | ------------------- | ------------------------------------ |
| `PolarMissingConfigProblem`         | `billing-polar/missing-config`                | InternalServerError | 필수 Polar 설정 누락                 |
| `PolarValidationProblem`            | `billing-polar/validation-failed`             | ValidationError     | Polar 요청 또는 설정 검증 실패       |
| `PolarCustomerNotFoundProblem`      | `billing-polar/customer-not-found`            | NotFound            | 고객 포털/고객 조회 대상 없음        |
| `PolarSubscriptionNotFoundProblem`  | `billing-polar/subscription-not-found`        | NotFound            | 구독 취소/재개 대상 없음             |
| `PolarRetryableUpstreamProblem`     | `billing-polar/retryable-upstream`            | InternalServerError | 재시도 가능한 Polar upstream 실패    |
| `PolarTerminalUpstreamProblem`      | `billing-polar/terminal-upstream`             | InternalServerError | 재시도로 복구되지 않는 upstream 실패 |
| `PolarUsageCustomerNotFoundProblem` | `billing-polar/usage-customer-not-found`      | NotFound            | usage billing account 없음           |
| `PolarUsageMeterMappingProblem`     | `billing-polar/usage-meter-mapping-not-found` | ValidationError     | usage meter binding 누락 또는 충돌   |
| `WebhookValidationProblem`          | `WEBHOOK_VALIDATION_FAILED`                   | BadRequest          | 웹훅 서명 또는 payload 검증 실패     |
| `WebhookProcessingProblem`          | `WEBHOOK_PROCESSING_FAILED`                   | InternalServerError | 웹훅 처리 실패                       |
| `BillingStatusMappingProblem`       | `BILLING_STATUS_MAPPING_FAILED`               | InternalServerError | 알 수 없는 결제 상태                 |

Polar SDK 오류는 not-found, validation, retryable upstream, terminal upstream Problem으로
정규화됩니다. SDK의 원본 token, webhook secret, authorization header는 Problem extensions에
포함하지 않습니다.

## 검증

기본 검증은 Polar credential 없이 실행됩니다.

## Canonical module plugin

`polarBilling()`은 `BILLING_GATEWAY_TOKEN`을 소유하는 실행 가능한 application plugin을 반환합니다.
생성된 애플리케이션은 이 factory의 metadata에서 필요한 환경 변수, capability, maturity, 검증 명령을
검사할 수 있습니다. 로거는 composition root가 명시적으로 전달하므로 전역 DI 등록 순서에 의존하지 않습니다.

```typescript
import { polarBilling } from "@croco/billing-polar";

const billing = polarBilling({
  accessToken: process.env.POLAR_ACCESS_TOKEN!,
  environment: "production",
  webhookSecret: process.env.POLAR_WEBHOOK_SECRET!,
  logger,
});
```

```bash
pnpm --filter @croco/billing-polar test
pnpm --filter @croco/testing test
```

`@croco/testing`의 `createBillingProviderConformanceSuite()`를 사용해 checkout, customer portal,
subscription lifecycle, webhook 처리, webhook idempotency, invalid signature/payload rejection을
mocked Polar backend로 검증합니다.

`POLAR_BILLING_PROVIDER_PROFILE`은 checkout과 usage capability를 지원하고, licensed-quantity capability는
지원하지 않는다는 사실과 이유를 공개합니다. Provider conformance는 두 capability가 독립적으로 구현됐는지
검증합니다.

`PolarWebhookHandler` 테스트는 credential 없이 real `@polar-sh/sdk` signature verifier를 통과하는
replayed signed delivery, duplicate event idempotency, stale timestamp/clock-skew rejection mapping,
invalid signature Problem code/status, 그리고 caller-facing Problem detail redaction을 검증합니다.
`PolarBillingDiagnosticsProvider` 테스트는 provider report에 signature-like diagnostics가 노출되지
않는지 확인합니다.

### Optional live smoke

live smoke는 환경 변수가 없으면 skip됩니다.

```bash
POLAR_ACCESS_TOKEN=... \
POLAR_WEBHOOK_SECRET=... \
POLAR_ORGANIZATION_ID=... \
POLAR_ENVIRONMENT=sandbox \
pnpm --filter @croco/billing-polar test -- src/tests/PolarLiveSmoke.spec.ts
```

이 smoke는 configured organization을 읽는 read-only readiness check만 수행합니다. ContractGraph에서
추출한 product/price mapping drift도 명시적으로 확인하려면 다음 변수를 추가합니다. 이 preflight도
product 조회만 수행하며 생성이나 수정 API는 호출하지 않습니다.

```bash
POLAR_ACCESS_TOKEN=... \
POLAR_PRODUCT_ID=... \
POLAR_PRICE_IDS=price_monthly,price_overage \
POLAR_ENVIRONMENT=sandbox \
pnpm --filter @croco/billing-polar test -- src/tests/PolarLiveSmoke.spec.ts
```

### Opt-in usage certification

실제 Polar usage event를 한 번 전송하는 certification은 아래 값을 **모두** 제공했을 때만 실행됩니다.
이 경로는 provider usage를 실제로 증가시킬 수 있으므로, 테스트용 customer/meter와 사전에 선택한 고유
`POLAR_USAGE_EVENT_ID`만 사용하세요. 같은 ID로 재실행하면 Polar duplicate receipt로 안전하게 검증합니다.

```bash
POLAR_ACCESS_TOKEN=... \
POLAR_WEBHOOK_SECRET=... \
POLAR_USAGE_EXTERNAL_CUSTOMER_ID=tenant-certification \
POLAR_USAGE_EVENT_NAME=ai_tokens_consumed \
POLAR_USAGE_EVENT_ID=croco-certification-2026-08-02 \
POLAR_USAGE_METER_ID=... \
POLAR_ENVIRONMENT=sandbox \
pnpm --filter @croco/billing-polar test -- src/tests/PolarLiveSmoke.spec.ts
```

scheduled live lane은 위 세 smoke 그룹의 모든 값을 같은 이름의 repository secret에서 주입합니다.
`POLAR_PRODUCT_ID`와 `POLAR_PRICE_IDS`는 mapping 조회에만 사용하는 read-only 입력입니다.
`POLAR_USAGE_EXTERNAL_CUSTOMER_ID`, `POLAR_USAGE_EVENT_NAME`, `POLAR_USAGE_METER_ID`는 사전에 만든
certification 리소스를 가리키며, `POLAR_USAGE_EVENT_ID`는 재실행마다 바꾸지 않는 전용 replay-safe identity여야
합니다. 설정이 빠지면 lane runner는 누락된 변수 이름만 보고하고 값은 출력하지 않은 채 Polar lane 실행을
거부합니다.

## 의존성

| 패키지                     | 버전 | 설명                           |
| -------------------------- | ---- | ------------------------------ |
| `@croco/billing-core`      | -    | 빌링 도메인 모델               |
| `@croco/diagnostics-core`  | -    | safe readiness diagnostics     |
| `@croco/events-core`       | -    | 이벤트 발행/구독               |
| `@croco/telemetry-api`     | -    | 분산 추적                      |
| `@croco/framework-context` | -    | DI 컨테이너                    |
| `@croco/metering-core`     | -    | durable billable usage journal |
| `@polar-sh/sdk`            | -    | Polar SDK                      |
| `zod`                      | -    | 스키마 검증                    |

## 라이선스

Apache-2.0

---

## 성숙도 안내

| 항목                 | 상태                                                                     | 설명                                                                                                    |
| -------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| **현재 상태**        | 🟡 beta                                                                  | 기능 완성, 실사용 검증 중                                                                               |
| **주요 기능**        | Checkout 생성, Webhook 처리, 구독 관리 (활성화/취소/재개), 고객 포털 URL | Polar 플랫폼 핵심 연동 기능                                                                             |
| **테스트 존재 여부** | ✅                                                                       | 단위테스트, billing conformance, diagnostics, optional live smoke test                                  |
| **운영 증거 수준**   | L2                                                                       | credential 없는 mocked conformance와 readiness diagnostics 있음 / live Polar smoke는 env-gated optional |

### 참고

- 이 패키지는 `@croco/billing-core` 인터페이스를 구현합니다.
- 웹훅 서명 검증과 멱등성 처리가 구현되어 있습니다.
- 재시도 정책(지수 백오프)이 적용되어 있습니다.
- production-ready 승격에는 기본 conformance와 diagnostics 통과 외에도 실제 Polar credential로 수행한
  optional live smoke 증거가 필요합니다. package catalog maturity는 해당 증거가 확인되기 전까지 beta로
  유지합니다.
