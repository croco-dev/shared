# AGENTS.md

AI 코딩 에이전트용 프로젝트 가이드 - TypeScript 모노레포

## Commands

```bash
# Build
pnpm build              # 전체 패키지 빌드
pnpm --filter @croco/framework-context build  # 단일 패키지 빌드

# Test
pnpm test               # 전체 테스트
pnpm --filter @croco/retry-core test  # 단일 패키지 테스트
pnpm --dir packages/retry-core vitest run src/tests/Retryable.spec.ts  # 단일 테스트 파일
pnpm --dir packages/retry-core vitest run -t "should retry"  # 테스트 이름으로 실행

# Lint & Format
pnpm lint               # 전체 lint (read-only)
pnpm --filter @croco/retry-core lint  # 단일 패키지 lint (read-only)
pnpm format             # 전체 formatter 적용 (파일 변경)

# Repository Verification
pnpm check              # 전체 저장소 verification gate (read-only)

# Type Check
pnpm typecheck          # 전체 패키지
pnpm --filter @croco/events-core typecheck  # 단일 패키지
```

`pnpm check`의 로컬 Markdown/JSON 검증 보고서는 작업트리를 변경하지 않도록 OS 임시 디렉터리에 저장한다.
CI와 release workflow는 업로드할 보고서 경로를 `--output-dir`로 명시한다.

## Croco Design Principles

Croco는 런타임에서 추측하게 하지 않고, 빌드타임에 의도를 명시하고 검증하며, 사람과 LLM이 모두 이해 가능한 실행 가능한 계약을 중심으로 동작하는 프레임워크다. 구현 판단은 아래 기준을 따른다.

- **Type-first**: route, RPC, Problem, DI token/scope, policy, runtime capability, package entrypoint는 가능한 한 타입으로 드러낸다. 문서에만 존재하는 계약은 충분하지 않다.
- **Build-time-first**: 잘못된 decorator 조합, 누락된 registration, package boundary 침범, contract drift, runtime capability mismatch는 runtime fallback보다 typecheck, build, lint, codegen, CI에서 먼저 실패하게 한다.
- **Explicit artifacts**: decorator/reflection 편의를 유지하더라도 최종 controller/handler/provider/route/manifest/registration table/intent map은 검사 가능한 산출물로 표현한다.
- **Contracts over conventions**: route contract, OpenAPI/RPC snapshot, Problem union, public API snapshot, package manifest normalization처럼 깨지는 표면은 자동 검증되는 contract를 둔다.
- **Failure as a model**: 일반 `Error`, catch-all, silent fallback으로 실패를 숨기지 않는다. `Problem`, retry, timeout, circuit breaker, idempotency, exhaustive handling, 안정적 diagnostic code로 복구 경로를 드러낸다.
- **Observable by default**: request lifecycle, trace, retry, event, Problem, DI scope, telemetry init/flush 경계는 원인 추적 가능한 evidence를 남긴다. 관측 실패를 비즈니스 성공처럼 보이게 하지 않는다.
- **LLM-readable architecture**: 안정적인 에러 코드, source location, manifest, intent map, 타입 기반 문서, deterministic generated output을 선호한다. 사람과 LLM이 같은 구조를 읽고 같은 수정 지점을 찾을 수 있어야 한다.
- **Generated, not hand-wired**: client, OpenAPI/RPC, docs examples, registration table, package catalog 같은 glue code는 수동 동기화보다 generation과 drift gate를 우선한다.
- **Production path first**: 예제와 preset은 배포, runtime limitation, telemetry flush, CI quality gate, migration, compatibility, zero-credential smoke를 먼저 통과해야 한다.
- **Composable boundaries**: adapter, middleware graph, policy, runtime capability, package layering 경계를 명확히 하며 core package가 provider/runtime 구현체에 오염되지 않게 한다.
- **Operational simplicity**: 같은 결과를 낼 수 있다면 새 GitHub App, credential, secret,
  environment, workflow, cron, 외부 서비스, 비상 경로를 추가하지 않는다. 운영 구성을 늘릴
  때는 기존 수단으로 해결할 수 없는 이유와 검증 가능한 이득이 있어야 하며, 권한 범위뿐
  아니라 설치, 승인, rotation, 관측, 장애 복구, 폐기까지 포함한 총 운영비용이 더 작은
  설계를 선택한다.

## Code Style

formatter는 Oxfmt, linter는 Oxlint를 사용한다. 아래 요약보다 `.oxfmtrc.json`과 `.oxlintrc.json`이 source of truth다.

- Indent: 2 spaces
- Line width: 120 characters
- Quote style: single quotes
- Trailing commas: ES5 style
- Type imports 필수 (`import type { X }` 사용, Oxlint error)
- 미사용 imports/variables 금지 (Oxlint error)
- `any` 명시적 사용 금지 (Oxlint error)
- Non-null assertion 금지 (Oxlint error)
- test file에는 `.oxlintrc.json`의 override가 적용되어 일부 규칙이 완화된다.

## Import Order

다음은 project convention이며 현재 formatter/linter가 자동 정렬을 보장하지 않는다.

1. 외부 패키지 (reflect-metadata, typedi 등)
2. 내부 @croco/\* 패키지
3. 상대 경로 (./libs/\*, ../types)
4. Type imports 별도 분리

## Naming Conventions

- Classes: PascalCase (RetryTemplate, CircuitBreaker)
- Interfaces: PascalCase, "I" 접두사 금지 (RetryPolicy, 아닌 IRetryPolicy)
- Types: PascalCase (BackoffOptions, ComponentMetadata)
- Constants: SCREAMING_SNAKE_CASE (REST_CONTROLLER_KEY)
- Functions/methods: camelCase
- Files: 클래스는 PascalCase (Component.ts), 유틸리티는 camelCase
- Test files: `src/tests/[ClassName].spec.ts` (필수 규칙)

## Decorator Pattern

```typescript
export function Retryable(options: RetryableOptions = {}): MethodDecorator {
  return (
    _target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor => {
    const originalMethod = descriptor.value;
    // ... 래핑 로직
    return descriptor;
  };
}

export function Component(options?: ComponentOptions): ClassDecorator {
  return (target: object) => {
    Container.register(target, options?.scope ?? "singleton");
  };
}
```

## Error Handling

RFC 7807 Problem 기반:

```typescript
export class NotFoundProblem extends Problem {
  readonly code = "NOT_FOUND";
  readonly category = ProblemCategory.NOT_FOUND;

  constructor(resource: string, id: string) {
    super(`${resource} with id '${id}' not found`);
  }
}

// Problem 하위클래스만 throw, 일반 Error 금지
throw new NotFoundProblem("User", userId);
```

## Test Patterns (Vitest)

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("ClassName", () => {
  let instance!: ClassName; // definite assignment

  beforeEach(() => {
    Container.reset(); // 항상 DI 컨테이너 리셋
    instance = new ClassName();
  });

  it("should do something", async () => {
    const result = await instance.method();
    expect(result).toBe(expected);
  });

  it("should handle errors", async () => {
    await expect(instance.failingMethod()).rejects.toThrow(SomeError);
  });
});
```

## Type Patterns

```typescript
// 객체 형태는 type 우선
export type BackoffOptions = {
  delay?: number;
  maxDelay?: number;
  multiplier?: number;
};

// 계약/구현은 interface
export interface RetryPolicy {
  shouldRetry(error: Error, attempt: number, maxAttempts: number): boolean;
}

// 제네릭 제약조건
export type Constructor<T = unknown> = new (...args: unknown[]) => T;
```

## Barrel Exports (index.ts)

```typescript
// 카테고리별 그룹화, types 마지막
export { Container, Context } from "./libs/Container";
export { Component } from "./libs/decorators/Component";
export type { ComponentMetadata, Scope, Token } from "./libs/types";
```

## Package Structure

```
packages/[name]/
├── src/
│   ├── index.ts          # Barrel exports
│   ├── libs/             # 구현
│   │   ├── ClassName.ts
│   │   └── decorators/   # 데코레이터가 있을 경우
│   └── tests/            # 테스트 파일 (*.spec.ts)
├── package.json
└── tsconfig.json
```

## Git Hooks (Lefthook)

- pre-commit: staged TypeScript/JavaScript 파일에 Oxlint fix를 적용하고, 지원되는 staged 파일에 Oxfmt를 적용한 뒤 다시 stage한다.
- pre-push: auto-changeset, 전체 test, tracked-file mutation guard로 감싼 전체 typecheck를 순서대로 실행한다.
- post-merge: `pnpm install`

정확한 hook command와 대상 glob은 `lefthook.yaml`이 source of truth다.

이 저장소의 기본 브랜치는 main이 아니라 trunk다. 브랜치 관련 예시와 기준은 trunk를 기준으로 해석한다.

## Branching & Release

- `trunk`는 보호 브랜치다. **직접 push 금지** — 모든 변경은 PR을 통해 머지한다.
- 버전 bump와 npm publish는 changesets 흐름을 따른다:
  1. 변경 사항이 있는 PR에는 `.changeset/*.md` 파일을 함께 포함한다 (`pnpm changeset`).
  2. trunk 머지 후 `changesets/action`이 자동으로 "Version Packages" Release PR을 생성한다.
  3. 그 Release PR을 머지하면 비로소 npm에 publish된다.
- package.json 버전을 수기로 bump하거나 trunk에 release 커밋을 직접 push하지 않는다. 의도치 않은 publish의 원인이 된다.

## Telemetry & Tracing

Croco는 OpenTelemetry 표준을 기반으로 한 분산 추적(Distributed Tracing)을 제공합니다.

### 패키지 구조

```
@croco/telemetry-api      # 애플리케이션에서 사용하는 API (@Trace, withSpan)
@croco/telemetry-sdk-node  # SDK 초기화 및 설정 (OpenTelemetry SDK 래핑)
```

### API vs SDK 분리

- **telemetry-api**: 애플리케이션 코드에서 사용
  - `@Trace` 데코레이터: 메서드 자동 추적
  - `withSpan`: 함수 실행 감싸기
  - `recordError`, `recordEvent`: Span에 이벤트/에러 기록
  - `getActiveTraceInfo`: 현재 Trace 컨텍스트 정보

- **telemetry-sdk-node**: 애플리케이션 시작 시 초기화
  - `TelemetryRuntime.init()`: OpenTelemetry SDK 초기화
  - `lambdaPreset`: Lambda 환경 최적화 설정
  - `ProbabilitySampler`: 샘플링 비율 제어

### 사용 패턴

```typescript
// 1. 애플리케이션 시작 시 SDK 초기화 (전역 스코프)
import { TelemetryRuntime, lambdaPreset } from "@croco/telemetry-sdk-node";

const telemetry = TelemetryRuntime.getInstance();
await telemetry.init(
  lambdaPreset({
    serviceName: "my-service",
    probability: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
  }),
);

// 2. 서비스 클래스에서 @Trace 데코레이터 사용
import { Trace } from "@croco/telemetry-api";

@Service()
class OrderService {
  @Trace({ name: "order.create" })
  async createOrder(dto: CreateOrderDto): Promise<Order> {
    // 자동으로 추적됨
    return this.repository.save(dto);
  }
}

// 3. Lambda 핸들러에서 forceFlush (데이터 전송 보장)
export const handler = async (event: any) => {
  try {
    return await processEvent(event);
  } finally {
    await telemetry.forceFlush();
  }
};
```

### Lambda 환경 주의사항

**⚠️ `AWS_LAMBDA_EXEC_WRAPPER`를 사용하지 마세요**

OpenTelemetry 공식 문서와 달리, Croco에서는 Exec Wrapper 방식을 사용하지 않습니다. 대신 다음 방식을 사용하세요:

1. 핸들러 파일 상단에서 전역 스코프로 `TelemetryRuntime.init()` 호출
2. 핸들러 반환 전에 `forceFlush()` 호출

이유:

- Layer 의존성 제거
- 콜드 스타트 최적화
- 초기화 타이밍 직접 제어

### OTLP 전용

Croco는 **OTLP(OpenTelemetry Protocol)만 지원**합니다. X-Ray와 통합하려면 ADOT Collector를 사이드카로 실행해야 합니다:

```yaml
# collector.yaml (ADOT Collector)
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

exporters:
  awsxray:
    region: ap-northeast-2

service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [awsxray]
```

### 샘플링 전략

| 환경        | 확률       | 설명                   |
| ----------- | ---------- | ---------------------- |
| development | 1.0 (100%) | 모든 요청 추적         |
| staging     | 0.5 ~ 1.0  | 50~100% 추적           |
| production  | 0.01 ~ 0.1 | 1~10% 추적 (비용 절감) |

## Architecture Notes

- Canonical roles: Kernel, Contracts, Plugins, Application, Profiles, Tooling. `docs/package-catalog.json`의 `packageRoles`가 source of truth이며 domain, subtype, runtimes는 별도 메타데이터다.
- 의존 방향: Application은 Profiles/Plugins/Contracts를 조합하고, Plugins는 Contracts/Kernel에 의존한다. Kernel/Contracts는 구체적인 Plugins에 의존하지 않는다. 역할은 요청 실행 순서가 아니다.
- `tx-drizzle`은 provider Plugin, `telemetry-api`는 Contracts다. Protocol, Host, Transport, Integration, Presentation은 Plugin subtype이다. `protocols-graphql`과 `protocols-trpc`는 구체적인 protocol Plugin이다.
- `framework-preset`은 build-target Tooling, `presentation-preset`은 Profiles다. Host 수명주기, Transport 실행, Build Target 산출물 계약은 별도 책임이다.
- DI: typedi + 커스텀 Container 래퍼
- AsyncLocalStorage: request-scoped context
- 이벤트 기반 아키텍처 (events-core + events-inmemory)
- 분산 추적: OpenTelemetry OTLP 기반 (@croco/telemetry-api + @croco/telemetry-sdk-node)

## Dependency Rules

### repository-core

`@croco/repository-core`는 **인터페이스 레이어**다. 아래 의존성을 가져서는 안 된다:

- `drizzle-orm` — ORM 라이브러리 직접 참조 금지
- `@croco/tx-drizzle` — Drizzle 구현체 참조 금지
- `@croco/tx-core`의 Drizzle 관련 타입 직접 사용 금지

Drizzle 기반 구현체(`AbstractDrizzleRepository` 등)는 반드시 `@croco/tx-drizzle` 패키지에 위치해야 한다.

위반 체크: `grep -r "drizzle" packages/repository-core/src/`가 결과를 출력하면 의존성 오염이다.
