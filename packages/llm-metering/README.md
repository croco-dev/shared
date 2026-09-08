# @croco/llm-metering

LLM 토큰 사용량과 비용을 기록하고 quota를 강제하는 LLM 미터링 패키지입니다.

## 설치

```bash
pnpm add @croco/llm-metering
```

## 사용법

```ts
import { LlmMeteringService } from "@croco/llm-metering";

const metering = new LlmMeteringService({
  meteringService,
  eventBus,
  pricingTable,
  quotaPolicy,
});

await metering.recordUsage({
  tenantId: "tenant-123",
  modelId: "gpt-4o-mini",
  provider: "openai",
  usage: {
    promptTokens: 120,
    completionTokens: 80,
    totalTokens: 200,
    accuracy: "EXACT",
  },
  idempotencyKey: "req-1",
});
```

```ts
import { AiMetered, runWithLlmMeteringService, setLlmMeteringService } from "@croco/llm-metering";

setLlmMeteringService(metering);

class LlmFacade {
  @AiMetered()
  async generate(): Promise<unknown> {
    return llmService.generate({ modelId: "default", prompt: "안녕" });
  }
}

await runWithLlmMeteringService(metering, () => new LlmFacade().generate());
```

`@AiMetered`는 기본적으로 계량 service를 요구합니다. 계량하지 않는 호출은
`@AiMetered({ metering: "disabled" })`로 의도를 명시해야 합니다. 동시 tenant 요청은
`runWithLlmMeteringService()`로 요청별 service를 바인딩하며, 전역 service보다 실행 scope가 우선합니다.

`@AiMetered`의 기본 멱등성 키는 호출마다 새로 생성됩니다. 같은 요청 안에서 같은 인자로
여러 번 호출해도 각각의 사용량을 기록합니다. 재시도 등에 동일한 멱등성 키가 필요하면
`idempotencyKeyExtractor`가 동일한 키를 반환하도록 지정합니다.

테넌트는 데코레이터의 `tenantId` 옵션, `Context.getTenantId()`, 인스턴스의 `tenantId`,
`"default"` 순으로 결정됩니다.

## API 레퍼런스

### 핵심 클래스

- `LlmMeteringService`, 토큰 사용량 기록, 비용 계산, quota 확인을 담당합니다.
- `PricingTable`, 공급자와 모델별 가격표를 조회하고 비용을 계산합니다.

### 데코레이터와 유틸리티

- `@AiMetered`, 메서드 결과에서 사용량을 추출해 자동 기록합니다.
- `setLlmMeteringService`, `getLlmMeteringService`, 데코레이터용 전역 기본 service를 관리합니다.
- `runWithLlmMeteringService`, 동시 실행별 service를 격리합니다.
- `createMeteredAsyncIterable`, 정상 완료·조기 종료·consumer 예외 시 수신한 사용량을 기록합니다. 미터링 종료 실패는 관측 가능하게 보고하며, 이미 발생한 provider 오류를 보존합니다.
- `extractUsageFromChunk`, 청크에서 usage와 모델 정보를 추출합니다.

### 주요 타입

- `LlmUsageEvent`, `LlmCostRecord`, `LlmMeteringServiceOptions`
- `LlmUsageRecord`, `LlmEmbeddingUsageRecord`, `LlmCostBudget`, `ModelPricing`

### 이벤트와 문제 타입

- 이벤트: `LlmUsageRecordedEvent`, `LlmCostBudgetExceededEvent`
- 문제 타입: `LlmMeteringRecordFailedProblem`, `LlmQuotaExceededProblem`, `LlmCostLimitExceededProblem`, `PricingNotFoundProblem`

## 구현 포인트

- 내부적으로 `@croco/metering-core`에 `llm.prompt_tokens`, `llm.completion_tokens`, `llm.cost_usd_nanos` 같은 meter를 기록합니다. USD 비용은 손실 없는 정수 계약을 위해 1 USD = 1,000,000,000 nanodollars로 기록하며, nanodollar 단위로 정확히 표현할 수 없는 가격은 기록 전에 거부합니다.
- 스트리밍 응답과 임베딩 결과 모두 같은 서비스에서 다룰 수 있습니다.
- `PricingTable.fromRegistry()`로 version/source/effectiveDate가 있는 가격 registry를 주입합니다. 기본 `samplePricingRegistry`는 테스트와 데모용 sample data이며 현재 공급자 가격으로 간주하지 않습니다.
- `quotaPolicy`는 기록 전 projected usage를 검사합니다. `metering-core` meter quota도 함께 등록하면 기록 중 quota도 fail-closed로 유지됩니다.

### `llm.cost_usd` 마이그레이션

업그레이드 전에 기존 `llm.cost_usd` writer를 모두 중지하고 `llm.cost_usd_nanos` meter를 등록합니다. 기존 USD quota는
`1_000_000_000`을 곱한 정수 quota로 변환하며, PostgreSQL metering 저장소는 먼저
`widenMeteringIntegersPostgres()`를 실행합니다. 기존 cost history는 원본 USD 값을 nanodollar 정수로 정확히 변환할 수
있는 경우에만 새 meter로 backfill하고, 전환 시점 이후에는 두 meter를 동시에 쓰지 않습니다. 읽기 경로도 새 meter로
전환한 뒤 구 `COST_USD` 상수는 레거시 데이터 식별에만 사용합니다.

- 미터링 실패 정책은 명시적 fail-closed입니다. 현재 지원되는 정책은 `failurePolicy: "fail-closed"`이며, quota policy 또는 meter write가 실패하면 `LlmMeteringRecordFailedProblem`/`LlmQuotaExceededProblem`으로 실패 meter와 quota 정보를 보존합니다.
- `LlmTelemetryBridge`는 `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.prompt_tokens`, `gen_ai.usage.completion_tokens`, `gen_ai.usage.cost_usd`, `gen_ai.client.user`, `gen_ai.usage.accuracy` 속성과 `llm.usage` 이벤트를 기록합니다.
- 전체 provider/pricing/quota/telemetry 가이드는 [docs/llm-governance.md](../../docs/llm-governance.md)를 참고하세요.
