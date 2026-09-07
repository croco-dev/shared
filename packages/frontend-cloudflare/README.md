# @croco/frontend-cloudflare

> Croco Presentation adapter — Host 생명주기, Transport 프로토콜 실행, Build Target 산출물 계약과 독립적으로 조합됩니다.

Cloudflare Workers에서 meta-vite `RenderServer` 기반 SSR을 실행하는 Worker 핸들러입니다.
서비스 바인딩 API 라우팅, Worker assets fallback, streaming `Response` 보존, 그리고
Cloudflare `RuntimeContext` 전달을 패키지 테스트와 생성 앱 smoke로 검증합니다.

## 상태

`@croco/frontend-cloudflare`는 Worker SSR beta gate evidence를 갖춘 beta 패키지입니다.

검증 evidence:

- `packages/frontend-cloudflare/src/tests/CloudflareSsrHandler.spec.ts`
  - Worker SSR 성공/실패 경로
  - `API_WORKER` 및 커스텀 서비스 바인딩 라우팅
  - `ASSETS` 응답/404 fallback/실패 fallback
  - streaming `Response` body 보존
  - `RuntimeContext.env`와 `RuntimeContext.executionContext` 전달
- `CROCO_GENERATED_SMOKE_CASES=meta-vite-fullstack-workers pnpm create-croco-app:smoke`
  - 생성된 Cloudflare SSR Worker가 실제 Worker export를 통해 assets, service binding API,
    streaming response, SSR page, env/context propagation을 검증

## 런타임 증거

이 패키지의 beta runtime claim은 package-level Worker handler test와 zero-credential
generated-app smoke가 함께 검증합니다.

- `pnpm --filter @croco/frontend-cloudflare test`는 Worker SSR handler의 service-binding API
  routing, ASSETS fallback, streaming response body preservation, env/context propagation, and
  clear failure responses를 검증합니다.
- `pnpm create-croco-app:smoke meta-vite-fullstack-workers`는 generated `ssr-worker`가
  `@croco/frontend-cloudflare` handler로 asset fallback, service-bound API routing, SSR page data
  flow, Worker env/context propagation, and streaming preservation을 Cloudflare credential 없이
  검증합니다.
- API reference는 `packages/docs/src/content/docs/api/frontend-cloudflare/`에서 생성됩니다.

## 설치

```bash
pnpm add @croco/frontend-cloudflare
```

## Worker 엔트리

```typescript
import { createSsrHandler } from "@croco/frontend-cloudflare";
import { RenderServer } from "@croco/meta-vite";
import registry from "./pages/route";

const renderServer = new RenderServer(registry.compile());
const fetch = createSsrHandler({ renderServer });

export default { fetch };
```

## Bindings

`wrangler.toml` 예시:

```toml
[assets]
directory = "dist/client"

[[services]]
binding = "API_WORKER"
service = "my-api-worker"
```

`API_WORKER`와 `ASSETS`는 선택 사항입니다. 추가 Worker binding은 `env`에 보존되어
`RenderServer`로 전달됩니다.

## Request Routing

핸들러는 같은 `Request` 객체를 유지하며 다음 순서로 처리합니다.

1. `env.ASSETS.fetch(request)`가 404가 아닌 응답을 반환하면 그 응답을 그대로 반환합니다.
2. assets 응답이 404이면 다음 단계로 진행합니다.
3. assets binding 호출이 throw되면 안정적인 diagnostic report를 남기고 API 또는 SSR fallback으로
   진행합니다.
4. 요청 path가 `/api/`로 시작하고 API service binding이 있으면 `apiBindingName`에 해당하는
   `Fetcher`로 라우팅합니다.
5. `renderServer`가 있으면 `{ platform: "cloudflare", env, executionContext }`를
   `RuntimeContext`로 전달해 SSR을 실행합니다.

`apiBindingName` 기본값은 `API_WORKER`입니다.

```typescript
export default {
  fetch: createSsrHandler({
    renderServer,
    apiBindingName: "INTERNAL_API",
    onFailure: ({ code, correlationId, error }) => {
      console.error(code, correlationId, error);
    },
  }),
};
```

## Streaming

서비스 바인딩이나 SSR render server가 반환한 `Response`는 buffering 없이 그대로 반환됩니다.
Workers 런타임이 지원하는 streaming body는 `ReadableStream` 상태로 보존됩니다.

## Failure Behavior

| State                            | Response                                                            | Recovery                                                                            |
| -------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `ASSETS` binding returns 404     | API 또는 SSR fallback 계속                                          | 해당 asset이 build output에 포함됐는지 확인합니다.                                  |
| `ASSETS` binding throws          | API 또는 SSR fallback 계속, `CROCO_CLOUDFLARE_ASSET_BINDING_FAILED` | binding 이름과 Worker assets 설정을 확인합니다.                                     |
| API service binding throws       | redacted Problem, `CROCO_CLOUDFLARE_API_BINDING_FAILED`             | API Worker deploy, service binding 이름, upstream 로그를 확인합니다.                |
| SSR render server throws         | redacted Problem, `CROCO_CLOUDFLARE_SSR_RENDER_FAILED`              | route component, server-only import, render 로그를 확인합니다.                      |
| `renderServer` missing           | `500 No render server configured`                                   | Worker entry에서 `new RenderServer(registry.compile())`를 넘깁니다.                 |
| API binding missing for `/api/*` | SSR fallback 또는 render-server 404/500                             | API를 service binding으로 제공하려면 `apiBindingName`과 `wrangler.toml`을 맞춥니다. |

API와 SSR 경계 실패는 `application/problem+json`과 `x-croco-diagnostic-code`를 사용하고
`cache-control`을 `no-store`로 설정합니다. 요청의 `x-croco-correlation-id`, `x-request-id`, `cf-ray`
순서로 correlation ID를 보존하며 내부 오류 메시지는 응답에 포함하지 않습니다. `onFailure`에는 원본
오류와 query string을 제외한 요청 문맥이 전달되고, reporter가 throw 또는 reject해도 원래 fallback이나
실패 응답은 유지됩니다. Promise를 반환하는 reporter는 응답 경로와 분리되며 Cloudflare
`ExecutionContext.waitUntil`을 사용할 수 있을 때 그 수명 주기에 등록됩니다.

## Types

```typescript
export type SsrWorkerEnv = Record<string, unknown> & {
  API_WORKER?: Fetcher;
  ASSETS?: Fetcher;
};

export type SsrHandlerOptions = {
  apiBindingName?: string;
  onFailure?: SsrFailureReporter;
};
```

## Verification

```bash
pnpm --filter @croco/frontend-cloudflare test
CROCO_GENERATED_SMOKE_CASES=meta-vite-fullstack-workers pnpm create-croco-app:smoke
pnpm docs:catalog:check
```

## License

Apache-2.0
