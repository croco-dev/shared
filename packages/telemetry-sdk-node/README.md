# @croco/telemetry-sdk-node

Node.js와 AWS Lambda에서 OpenTelemetry SDK를 초기화하는 런타임 패키지입니다. OTLP exporter, 샘플링, 자동 계측, flush 제어를 제공합니다.

## 설치

```bash
pnpm add @croco/telemetry-sdk-node
```

## Canonical module plugin

`nodeTelemetry()` is the canonical application-owned integration. It provides the existing `TelemetryRuntime` singleton
through the module graph, starts it with `ApplicationRuntime.initialize()`, and contributes deterministic telemetry
diagnostics. Application runtimes with the same configuration share lifecycle ownership; the singleton shuts down only
after the final owner is disposed, while conflicting configurations fail explicitly.

```typescript
import { createApplicationRuntime, defineCrocoApplication } from "@croco/framework-module";
import { nodeTelemetry, TELEMETRY_RUNTIME_TOKEN } from "@croco/telemetry-sdk-node";

const application = createApplicationRuntime(
  defineCrocoApplication({
    imports: [
      nodeTelemetry({
        serviceName: "orders-api",
        trace: { exporterUrl: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT },
      }),
    ],
  }),
);

await application.initialize();
const telemetry = application.get(TELEMETRY_RUNTIME_TOKEN);

try {
  // Run the application.
} finally {
  await application.dispose();
}
```

Direct `TelemetryRuntime.getInstance()` initialization remains supported for hosts that have not migrated to
`ApplicationRuntime`. Do not initialize the singleton directly and through `nodeTelemetry()` in the same application; the
runtime rejects conflicting configuration rather than selecting a lifecycle owner by registration order.

## 사용법

### 기본 초기화

```typescript
import { TelemetryRuntime } from "@croco/telemetry-sdk-node";

const telemetry = TelemetryRuntime.getInstance();
await telemetry.init({
  serviceName: "orders",
  trace: {
    enabled: true,
    exporterUrl: "http://localhost:4318/v1/traces",
  },
});
```

### Batch processor 조정

`trace.batchTimeout`은 `0`부터 `2_147_483_647`까지의 정수이며, `trace.batchCount`와
`trace.batchSize`는 `1`부터 `2_147_483_647`까지의 정수입니다. 유효 기본값을 적용한 뒤에도
`batchSize`는 `batchCount`보다 클 수 없습니다. 위반하면 OpenTelemetry SDK나 exporter를 만들기 전에
`TelemetryBatchConfigurationProblem`이 실패한 필드, 제약, 수신값과 함께 발생합니다.

### 자동 계측

`trace.autoInstrumentation`을 설정하면 Node 환경에서는 HTTP/HTTPS, Express, DNS, Net 계측이 기본으로
`NodeSDK`에 전달됩니다. `lambdaPreset()`은 HTTP/HTTPS, AWS SDK, AWS Lambda 계측을 자동으로 활성화합니다.
OpenTelemetry가 HTTP와 HTTPS에 하나의 공용 계측기를 제공하므로 `http`와 `https`는 항상 함께 선택하거나 함께
제외해야 하며, 부분 선택은 초기화 전에 명시적으로 실패합니다.

```typescript
await telemetry.init({
  serviceName: "orders",
  trace: {
    exporterUrl: "http://localhost:4318/v1/traces",
    autoInstrumentation: {
      modules: ["http", "https", "express", "pg"],
      excludeModules: ["express"],
      moduleOptions: {
        pg: { enhancedDatabaseReporting: true },
      },
    },
  },
});
```

`trace.instrumentations`의 custom 인스턴스가 먼저 적용되며, 같은 `instrumentationName`의 자동 인스턴스를
대체합니다. 그 다음 `autoInstrumentation.customInstrumentations`, 자동 인스턴스 순서로 병합되고, 각 이름의 첫
custom 인스턴스만 유지됩니다. `enabled: false`는 자동 인스턴스를 만들지 않습니다.

Upstream Node 자동 계측이 공통으로 실행할 수 없는 operation `include`/`exclude` 필터, 설치된 번들에 없는 모듈,
선택되지 않은 모듈의 options는 `TelemetryAutoInstrumentationProblem`으로 SDK 시작 전에 거부됩니다. Diagnostics에는
활성화된 OpenTelemetry 모듈 이름만 노출되고 exporter URL, header, 요청 데이터는 포함되지 않습니다.

### Lambda 프리셋

```typescript
import { TelemetryRuntime, lambdaPreset } from "@croco/telemetry-sdk-node";

const telemetry = TelemetryRuntime.getInstance();
await telemetry.init(
  lambdaPreset({
    serviceName: "orders",
    probability: 0.1,
  }),
);
```

### 종료 전 flush

```typescript
import { TelemetryForceFlushUnsupportedProblem } from "@croco/telemetry-sdk-node";

const result = await telemetry.forceFlush(5000);
if (result.outcome === "failed") {
  throw result.error;
}
if (result.outcome === "unsupported") {
  throw new TelemetryForceFlushUnsupportedProblem();
}
```

Lambda에서는 `@croco/preset-lambda`의 Host에 flush callback을 연결합니다. Lambda Host는 invocation
lifecycle과 flush 경계를 소유하고, `@croco/transports-http` 애플리케이션은 HTTP 실행을 소유합니다.
flush 실패는 handler 실패로 전파되어 trace export 실패가 성공 응답처럼 숨겨지지 않습니다.

```typescript
import { createApplicationRuntime } from "@croco/framework-module";
import { createLambdaHost } from "@croco/preset-lambda";
import { TelemetryForceFlushUnsupportedProblem } from "@croco/telemetry-sdk-node";
import { createApp } from "@croco/transports-http";

const runtime = createApplicationRuntime();
const app = runtime.run(() => createApp({ controllers: [] }));

const lambdaHost = createLambdaHost(app, {
  flush: async () => {
    const result = await telemetry.forceFlush(5000);
    if (result.outcome === "failed") {
      throw result.error;
    }
    if (result.outcome === "unsupported") {
      throw new TelemetryForceFlushUnsupportedProblem();
    }
  },
});

export const handler = runtime.bindHostCallback(lambdaHost);
```

### 초기화 수명주기

`init({ enabled: false })`와 `init({ trace: { enabled: false } })`는 설정만 저장하고 OpenTelemetry SDK를 시작하지
않습니다. 동일한 설정의 동시 또는 후속 `init()` 호출은 기존 초기화 계약을 공유합니다. 서비스, exporter 또는
enabled 상태가 다른 설정은 `telemetry-sdk-node/init-configuration-conflict` Problem으로 거부됩니다. 설정을 바꾸려면
먼저 `shutdown()`을 호출한 뒤 다시 `init()`을 호출합니다.

`isInitialized()`와 `isEnabled()`는 SDK가 실제로 초기화되어 활성화된 경우에만 `true`를 반환합니다.

### 지원 신호

이 패키지의 실행 가능한 신호 계약은 trace입니다. `TelemetryConfig`에는 `trace`만 존재하며 metrics/logs 설정과
`MetricsApi`/`LogsApi` façade를 제공하지 않습니다. 애플리케이션 메트릭에는 `@croco/metrics-core` 같은 도메인 계약을
사용하고, OTLP metrics/logs provider가 필요한 경우에는 해당 OpenTelemetry SDK를 애플리케이션에서 명시적으로
구성하세요.

### Degraded mode와 복구

Telemetry를 구성하지 않은 애플리케이션에서 기본 `TelemetryDiagnosticsProvider`는 선택적 capability가 비활성 상태임을
`degraded`와 `mode: "not_configured"`로 보고합니다. 이 상태를 readiness 실패로 취급할지는
`DiagnosticsHealthIndicator`의 `degradedStatus` 정책으로 결정합니다.

Telemetry 또는 trace를 의도적으로 끈 상태도 애플리케이션 실패가 아닙니다. `init({ enabled: false })`,
`init({ trace: { enabled: false } })`, 또는 `TELEMETRY_ENABLED=false`는 설정을 보존하지만 SDK와 exporter를 시작하지
않으며, diagnostics는 기존과 같이 `degraded`와 `mode: "disabled"`를 반환합니다.

Telemetry가 host readiness의 필수 조건이면 provider를
`new TelemetryDiagnosticsProvider({ requirement: "required" })`로 생성합니다. 필수 telemetry의 설정 누락 또는 초기화
실패는 `unhealthy`입니다. 초기화 실패는 재시도를 막는 runtime 설정 계약과 분리하여 보존되며,
`mode: "startup_failed"`와 안정적인 `failureCode`로 식별할 수 있습니다. 같은 실패도 기본 optional provider에서는
`degraded`로 보고됩니다.

모든 telemetry diagnostics details에는 `requirement`, `configured`, `initialized`, `mode`가 포함됩니다. 설정이 존재하면
`serviceName`, `environment`, `enabled`, `traceEnabled`, `probability`, `signals`, `autoInstrumentationModules`도 안전한
metadata로 제공됩니다. exporter URL, header, resource attribute 값은 diagnostics에 노출하지 않습니다.

Trace export를 켠 상태에서 OTLP endpoint가 없으면 초기화가 fail-closed 됩니다. `trace.enabled: false`로 명시해
무자격 로컬 실행을 허용하거나, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`/`OTEL_EXPORTER_OTLP_ENDPOINT` 또는
`trace.exporterUrl`을 설정한 뒤 다시 초기화하세요.

Exporter나 SDK 시작 실패는 `TelemetryRuntimeProblem`으로 정규화됩니다. 같은 프로세스에서 복구하려면 원인을 수정한
뒤 실패한 초기화가 반환된 후 다시 `init()`을 호출합니다. 초기화와 동시에 `shutdown()`을 호출하면 shutdown도 원래
초기화 오류로 실패하므로 초기화 실패가 성공적인 종료처럼 숨겨지지 않습니다.

Lambda에서는 handler 작업이 끝난 뒤 `forceFlush()` 결과를 확인하세요. Trace export 실패를 요청 성공처럼 숨기면 안
되는 경로에서는 `failed` 결과의 `error`를 throw 하고, `unsupported`는 초기화 누락으로 처리합니다. Telemetry를
명시적으로 비활성화한 환경은 `skipped`, 실제 processor가 flush를 마친 경우만 `completed`입니다.

프로세스를 종료하거나 같은 런타임 인스턴스를 새 설정으로 다시 초기화하기 전에는 `shutdown()`을 호출합니다. 실제 SDK
종료는 `completed`, 명시적 비활성화는 `skipped`, SDK가 없는 pre-init 상태는 `unsupported`입니다. `shutdown()`이
`completed`를 반환한 뒤에는 새 `init()` 호출로 trace runtime을 다시 시작할 수 있습니다.

`shutdown(timeoutMillis)`은 기본 30초 안에 한 번의 SDK 종료를 완료해야 합니다. 1부터 `2_147_483_647`까지의 정수만
허용되며, 동시 호출자는 첫 호출이 시작한 같은 종료 결과를 기다립니다. 종료 중 `init()`은 충돌 Problem으로 실패하고
`forceFlush()`는 종료 결과를 먼저 기다립니다. `telemetry-sdk-node/shutdown-timeout` 이후의 `shutdown()` 재호출은 새 SDK
종료를 시작하지 않고 이미 진행 중인 teardown을 새 제한 시간으로 다시 기다립니다. teardown이 완료된 뒤에는
OpenTelemetry 전역 provider와 instrumentation을 해제하므로 같은 프로세스에서 다시 초기화할 수 있습니다.

SDK 자체가 종료를 거부해 `TELEMETRY_RUNTIME_ERROR`가 발생한 경우에는 upstream의 일회성 종료 결과가 고정됩니다. 이
상태에서는 `shutdown()`, `forceFlush()`, `reset()`이 같은 실패를 보존하고 `init()`도 거부합니다. 원인을 해결한 뒤
프로세스를 다시 시작해야 하며, 런타임은 이 실패를 `completed`로 바꾸거나 두 번째 SDK 종료를 시작하지 않습니다.

## API 레퍼런스

- `TelemetryRuntime`: `init`, `forceFlush`, `shutdown`, `isInitialized`, `isEnabled`, `getConfig`
- `TelemetryDiagnosticsProvider`: optional/required telemetry 상태와 초기화 실패 진단
- `lambdaPreset`: Lambda 환경 기본 설정 생성
- `ProbabilitySampler`: 확률 기반 샘플링 구현체
- 자동 계측: `normalizeAutoInstrumentationConfig`, `LAMBDA_DEFAULT_MODULES`, `NODE_DEFAULT_MODULES`
- Problem: `OtlpEndpointRequiredProblem`, `SamplerProblem`, `TelemetryAutoInstrumentationProblem`,
  `TelemetryBatchConfigurationProblem`, `TelemetryShutdownTimeoutInvalidProblem`, `TelemetryShutdownTimeoutProblem`
- 타입: `TelemetryConfig`, `TraceConfig`, `ForceFlushResult`, `ShutdownResult`, `TelemetryLifecycleSkipReason`,
  `TelemetryBatchConfigurationField`, `TelemetryBatchConfigurationConstraint`, `TelemetryDiagnosticsProviderOptions`,
  `TelemetryDiagnosticsRequirement`, `TelemetryDiagnosticsMode`, `TelemetryDiagnosticsDetails`,
  `TelemetryDiagnosticsHealthStatus`

## Lambda 참고

- `AWS_LAMBDA_EXEC_WRAPPER` 방식은 사용하지 않습니다.
- 핸들러 바깥에서 `init()`을 호출합니다.
- 핸들러 종료 전에 `forceFlush()`를 호출합니다.
