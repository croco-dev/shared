# @croco/transports-http

Croco의 HTTP transport입니다. `@croco/protocols-rest`로 정의한 컨트롤러를 Hono 기반 HTTP 실행
surface로 연결합니다. Node 프로세스와 AWS Lambda invocation의 lifecycle은 각각
`@croco/preset-node`와 `@croco/preset-lambda`의 host API가 소유합니다.
HTTP 실패 응답은 Croco [Failure Semantics](../../packages/docs/src/content/docs/en/guides/failure-semantics.mdx)를 기준으로 `Problem`은 RFC 7807 응답으로 보존하고, generic `Error`는 unhandled internal fault로 취급합니다.

## 역할 경계

- **Host**는 Node server start/close, Lambda invocation, Workers fetch/waitUntil 같은 환경
  lifecycle을 소유합니다.
- **HTTP transport**는 request를 route pipeline으로 실행하고 response를 반환합니다.
- **Build target**은 entrypoint, output directory, module format, build hook을 기술합니다.

`CrocoApp.fetch()`와 route/pipeline API가 이 패키지의 canonical transport surface입니다.
`CrocoApp.listen()`, `CrocoApp.lambdaHandler()`, `nodeHandler()`, `startServer()`,
`toLambdaHandler()`는 기존 소비자를 위한 host convenience compatibility surface로 유지됩니다.
새 runtime composition에서는 `@croco/preset-node`의 `createNodeHost()` 또는
`@croco/preset-lambda`의 `createLambdaHost()`에 HTTP app을 명시적으로 bind합니다. 기존 package
이름이나 API가 rename되었다고 해석해서는 안 됩니다.

## 설치

```bash
pnpm add @croco/framework-module @croco/preset-lambda @croco/preset-node @croco/protocols-rest @croco/transports-http reflect-metadata
```

## 사용법

### 앱 생성과 Lambda host 연결

```typescript
import "reflect-metadata";
import {
  createSlidingWindowPolicy,
  RateLimitKeyBuilder,
  RateLimiter,
  SlidingWindowInMemoryStore,
} from "@croco/ratelimit-core";
import { createApplicationRuntime } from "@croco/framework-module";
import { createLambdaHost } from "@croco/preset-lambda";
import { Controller, Get } from "@croco/protocols-rest";
import {
  bodyLimitMiddleware,
  corsMiddleware,
  createApp,
  mb,
  rateLimitHttpMiddleware,
  securityHeadersMiddleware,
} from "@croco/transports-http";

@Controller("/users")
class UserController {
  @Get("/")
  list() {
    return [{ id: "user-1" }];
  }
}

const rateLimiter = new RateLimiter(
  new SlidingWindowInMemoryStore(),
  new RateLimitKeyBuilder(["ip"]),
);

const runtime = createApplicationRuntime();
await runtime.initialize();

const app = runtime.run(() =>
  createApp({
    controllers: [UserController],
    middlewares: [
      securityHeadersMiddleware(),
      corsMiddleware({ origins: ["https://example.com"] }),
      bodyLimitMiddleware({ limit: mb(1) }),
      rateLimitHttpMiddleware({
        rateLimiter,
        policy: createSlidingWindowPolicy("http", 100, 60_000),
      }),
    ],
  }),
);

export const handler = runtime.bindHostCallback(createLambdaHost(app));
```

### Repeated query and header parameters

Repeated query keys are preserved in `CrocoRequest.query`: one `?tag=a` value is a string and
`?tag=a&tag=b` is `string[]`. Accordingly, `CrocoHttpContext.query(name)` now returns
`string | string[] | undefined`. Applications that read query values directly must narrow or
validate the value before treating it as a scalar.

Named `@Query("tag")` parameters without an explicit schema retain the generated optional-scalar
contract and reject repeated values. Declare a Zod array schema when the controller parameter is
intended to accept repeated keys.

`Fetch` and Hono normalize duplicate request header lines into a comma-separated header value.
Croco retains that scalar header record, while `@Header()` parameters declared with Zod array
schemas receive a trimmed comma-separated string array before validation. Scalar header schemas
continue to receive one string.

### 요청 관측성과 Problem 메타데이터

등록된 컨트롤러 요청은 기본 HTTP server span 안에서 실행됩니다. 요청 중 `Problem` 또는 일반 에러가
발생하면 span에는 HTTP status와 Croco Problem code/category가 기록되고, Problem Details 응답에는
추적에 사용할 안전한 correlation metadata가 포함됩니다. `traceId`는 요청 trace가 있을 때 포함되고,
`requestId`는 runtime request id가 있을 때 포함됩니다. Node runtime의 `requestId`는 요청의
`x-request-id` 헤더를 우선 사용하고 없으면 transport가 생성한 id를 사용합니다. Lambda runtime의
`requestId`는 API Gateway `event.requestContext.requestId`를 우선 사용하고 없으면 Lambda
`awsRequestId`를 사용합니다.

Telemetry 설정 자체가 실패하면 요청은 degraded mode로 계속 처리되지만 `X-Croco-Telemetry-Degraded`
응답 헤더와 Problem Details의 `telemetry: { degraded: true, reason: "telemetry_setup_failed" }`
메타데이터로 실패 증거를 남깁니다. 응답에는 안정적인 degradation reason만 직렬화하고 setup exception
message, stack, raw header/body, secret 값은 포함하지 않습니다.

### RuntimeContext

컨트롤러, guard, interceptor, service에서는 `@croco/framework-context`의
`Context.getRuntimeContext()`로 Node/Lambda 요청의 공통 런타임 정보를 읽을 수 있습니다.

```typescript
import { Context } from "@croco/framework-context";

const runtime = Context.getRuntimeContext();

runtime?.waitUntil(Promise.resolve());

console.log(runtime?.platform); // "node" 또는 "lambda"
console.log(runtime?.requestId);
```

| Runtime | `env`         | `requestId`                                | `waitUntil` | `flush`                                 |
| ------- | ------------- | ------------------------------------------ | ----------- | --------------------------------------- |
| Node    | `process.env` | `x-request-id` 또는 generated id           | no-op       | no-op                                   |
| Lambda  | `process.env` | API Gateway request id 또는 `awsRequestId` | queued work | queued work drain, rejected work logged |

### Lambda API Gateway v2 요청 매핑

Lambda handler는 API Gateway v2 이벤트를 Fetch `Request`로 변환합니다.

| Event field                         | Fetch request behavior                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `requestContext.http.method`        | Fetch request method. 값이 없으면 `GET`을 사용합니다.                                      |
| `rawPath`, `rawQueryString`         | `https://lambda.local${rawPath}?${rawQueryString}` 형태의 request URL을 구성합니다.        |
| `headers`                           | Fetch `Headers`로 복사되며 Fetch 표준에 따라 대소문자 구분 없이 조회할 수 있습니다.        |
| `headers.cookie` / `headers.Cookie` | 명시된 `Cookie` header가 있으면 그대로 유지하며 `event.cookies`보다 우선합니다.            |
| `cookies`                           | 명시된 `Cookie` header가 없을 때 `; `로 join해 inbound Fetch `Cookie` header로 설정합니다. |
| `body`, `isBase64Encoded`           | base64 body는 `Buffer`로 디코딩하고, `GET`/`HEAD` 요청에는 body를 전달하지 않습니다.       |

원본 Lambda `event`와 `context`는 Hono env에 그대로 보존되며 `getLambdaEvent()`와
`getLambdaContext()`로 읽을 수 있습니다.

Lambda에서 OpenTelemetry span export까지 보장하려면 `@croco/telemetry-sdk-node`의
`TelemetryRuntime.forceFlush()`를 Lambda host의 flush callback으로 연결합니다. 이 callback이 실패하면 Lambda
handler도 실패하므로 관측 실패가 성공 응답으로 숨겨지지 않습니다.
Lambda handler는 요청 실행을 `finally` 경계로 감싸므로 Hono fetch 또는 route 실행이 응답 생성 전에
실패해도 queued `waitUntil` 작업을 먼저 drain하고 handler flush callback을 실행한 뒤 실패를 전파합니다.
요청 실패와 flush 실패가 함께 발생하면 원래 요청 실패와 flush 실패 목록을 모두 담은 diagnostic-coded
`LambdaFlushBoundaryError`로 실패합니다.

```typescript
import {
  TelemetryForceFlushUnsupportedProblem,
  TelemetryRuntime,
  lambdaPreset,
} from "@croco/telemetry-sdk-node";
import { createLambdaHost } from "@croco/preset-lambda";

const telemetry = TelemetryRuntime.getInstance();
await telemetry.init(lambdaPreset({ serviceName: "orders" }));

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

## Application module plugin

New application composition should declare HTTP controllers and middleware through the
`httpTransport()` plugin. Each contribution has an explicit stable `id` and optional numeric `order`;
the application runtime sorts by `order`, then `id`, and rejects duplicate identities before startup.

```ts
import { createApplicationRuntime, defineCrocoApplication } from "@croco/framework-module";
import { createApp, createHttpAppConfig, httpTransport } from "@croco/transports-http";

const runtime = createApplicationRuntime(
  defineCrocoApplication({
    imports: [
      httpTransport({
        controllers: [{ id: "orders", controller: OrdersController }],
        middlewares: [{ id: "security", order: 10, middleware: securityMiddleware }],
      }),
    ],
  }),
);

await runtime.initialize();
const app = runtime.run(() => createApp(createHttpAppConfig(runtime)));
```

`createApp({ controllers, middlewares })` remains supported as the compatibility path. It does not
publish contribution identity or plugin metadata, so profiles and generated application roots should
prefer `httpTransport()` and `createHttpAppConfig()`. Host callbacks must re-enter the owning runtime
with `runtime.run()` as described by `@croco/framework-module`.

### HEAD 요청과 GET 라우트

Croco HTTP 런타임은 GET-only 라우트에 들어온 `HEAD` 요청을 호환 동작으로 지원합니다. 이 경우 GET
핸들러와 같은 pipeline을 실행해 status/header를 보존하되 응답 body는 비워 반환합니다. 같은 path에
명시적인 `@Head()` 라우트가 있으면 `HEAD` 요청은 그 핸들러를 사용하며, `GET` 요청은 기존 `@Get()`
핸들러를 사용합니다.

ContractGraph와 OpenAPI는 선언된 decorator만 산출물로 노출합니다. GET-only 라우트는 ContractGraph와
OpenAPI에 `GET`만 기록되며, OpenAPI `head` operation이나 ContractGraph `HEAD` route가 필요하면
route author가 `@Head()`를 명시해야 합니다.

이 정책은 `CrocoApp.fetch`, `listen`, `lambdaHandler`, 그리고 `app.getHono().fetch`에 적용됩니다. Hono의
`route()`나 `basePath()`처럼 raw route를 복사하는 composition API는 Croco의 explicit `HEAD` sidecar를
포함하지 않으므로, explicit `HEAD` 정책의 실행 경계로 사용하지 않습니다.

### Lambda 응답 헤더와 쿠키 매핑

`app.lambdaHandler()`는 API Gateway HTTP API payload format v2 응답을 반환합니다. 일반 Fetch 응답
헤더는 `LambdaResponse.headers`의 single-value header record로 매핑합니다. `Set-Cookie` 응답 헤더는
single-value record에 넣지 않고 API Gateway v2 전용 `LambdaResponse.cookies: string[]`로 매핑합니다.
API Gateway는 `cookies` 배열의 각 값을 개별 `set-cookie` 응답 헤더로 변환하므로, auth/session 응답에서
여러 쿠키나 `Expires=Wed, 21 Oct ...`처럼 comma가 포함된 쿠키 값을 안전하게 보존할 수 있습니다.

JSON 응답은 문자열 body와 `isBase64Encoded: false`를 유지하고, binary 응답은 기존처럼 body를 base64로
인코딩한 뒤 `isBase64Encoded: true`를 반환합니다.

### Node 서버 실행

```typescript
import { createNodeHost } from "@croco/preset-node";

const host = createNodeHost({
  fetch: runtime.bindHostCallback((request) => app.fetch(request)),
});

await host.start();
```

종료 시에는 먼저 `host.close()`로 새 HTTP 연결을 중단하고, application/module cleanup이 끝난 뒤
`runtime.dispose()`를 호출합니다. `app.listen()`은 기존 entrypoint와 migration을 위해 계속
지원되는 compatibility convenience입니다.

### 헬스체크와 readiness 등록

```typescript
import { Container } from "@croco/framework-context";
import { HealthCheckRegistry } from "@croco/transports-http";

const healthChecks = Container.get(HealthCheckRegistry);

healthChecks.register("database-health", async () => ({ status: "up" }));
healthChecks.registerReadiness("database", async () => ({ status: "up" }));
```

## Operational Endpoints

`createApp()`는 별도 컨트롤러 없이 운영 endpoint를 등록합니다. Health와 readiness 실행은
`@croco/health-core`의 `HealthCheckService`를 통해 수행되며, `HealthCheckRegistry`는 generic health와
readiness를 독립된 이름 공간으로 등록하는 adapter입니다. `/health`는 `register()`로 등록한 체크를,
`/ready`와 `/health/ready`는 `registerReadiness()`로 등록한 체크만 실행합니다. Generic health 체크는
readiness 결과에 포함되지 않습니다.

| Endpoint                  | 기본 노출 | 성공 응답                               | 실패 응답                       |
| ------------------------- | --------- | --------------------------------------- | ------------------------------- |
| `GET /health`             | on        | `200 { "status": "up", "results": [] }` | `503 { "status": "down", ... }` |
| `GET /health/live`        | on        | `200 { "status": "ok" }`                | 없음                            |
| `GET /ready`              | on        | `200 { "status": "up", "results": [] }` | `503 { "status": "down", ... }` |
| `GET /health/ready`       | on        | `/ready`와 동일                         | `/ready`와 동일                 |
| `GET /health/diagnostics` | off       | `200 DiagnosticsReport`                 | `403 { "error": "Forbidden" }`  |

`/health`, `/ready`, `/health/ready`는 `@croco/health-core`의 `HealthCheckResult` aggregate contract를
반환합니다. 등록된 체크가 없으면 `{ "status": "up", "results": [] }`로 간주합니다. 체크 함수가
실패하거나 timeout을 넘기면 해당 체크는 `results` 배열에서
`{ "name": "...", "status": "down", "details": { "error": "..." } }`로 직렬화되고 전체 응답은
`503`입니다. 세 aggregate 경로의 HTTP 응답은 민감 key를 재귀적으로 `[Redacted]` 처리하고 모든
문자열을 100자로, 객체 key와 배열 항목을 각각 50개로 제한하며 `stack`과 `cause`를 노출하지
않습니다. 각 check의 세부 정보는 전체 500개 node와 10,000개 문자까지만 순회합니다.
`/health/live`는 등록된 체크와 독립적인 process liveness로 항상
`200 { "status": "ok" }`를 반환합니다.

### Diagnostics exposure policy

Diagnostics는 기본적으로 꺼져 있습니다. 앱 코드에서 명시하거나 기존 환경변수 경로를 사용할 수
있습니다.

```typescript
const app = createApp({
  controllers: [UserController],
  diagnostics: {
    exposure: "token",
    token: process.env.CROCO_DIAGNOSTICS_TOKEN,
  },
});
```

지원되는 exposure mode:

| Mode      | 동작                                                                             |
| --------- | -------------------------------------------------------------------------------- |
| `off`     | `/health/diagnostics`를 등록하지 않습니다. 기본값입니다.                         |
| `private` | token 없이 노출합니다. Private network, local smoke, internal LB에만 사용합니다. |
| `token`   | `X-Diagnostics-Token` 헤더가 configured token과 같을 때만 허용합니다.            |
| `custom`  | `guard` 함수가 true를 반환할 때만 허용합니다.                                    |

하위 호환을 위해 `CROCO_DIAGNOSTICS_ENABLED=true`도 지원합니다. 이때
`CROCO_DIAGNOSTICS_TOKEN`이 있으면 `token`, 없으면 `private`로 동작합니다. 새 설정에서는
`diagnostics.exposure` 사용을 권장합니다.

Diagnostics 응답은 `Cache-Control: no-store`를 포함합니다. `recentErrors`는 기본 최대 100개까지
최신순으로 반환되며 `cause`/stack trace는 노출하지 않습니다. 오류 메시지와 provider message는 기본
100자로 제한되고, `token`, `secret`, `password`, `authorization`, `cookie`, `credential`,
`apiKey` 계열 detail key는 `[Redacted]`로 대체됩니다. 필요하면 `recentErrorLimit`과
`messageLimit`을 조정할 수 있습니다. `recentErrorLimit`은 0 이상의 안전한 정수이고
`messageLimit`은 1 이상의 안전한 정수여야 하며, 잘못된 값은 엔드포인트 등록 전에
`transports-http/diagnostics-invalid-configuration` Problem으로 거절됩니다.

## Failure response contract

HTTP transport는 Croco `Problem` 또는 exception filter가 반환한 Problem Details 응답을
`type`, `title`, `status`, `code`, `detail`, `instance`와 registry redaction policy가 허용한
public extension만으로 직렬화합니다. 등록된 code는 generated
Problem registry의 `recovery.redactionPolicy`를 따르고, 등록되지 않은 code는 `ProblemCategory`
기본 recovery metadata로 fallback합니다. `public`과 `safe-message` 응답은 `detail`을 유지하되
`errors`, `issues`, `fields`, `field`, `formErrors`, `limit`, `remaining`, `resetAt`, `retryAfter`,
`retryAfterMs`, `retryAfterSeconds`, `retryAt`, `requested`, `current`, `max`, `currentSeats`,
`maxSeats`, `reason`, `recoveryAction`, `legacyCode`만 extension으로 노출합니다. `operator-only`
응답은 `detail`을 opaque 메시지로 바꾸고 Problem extension을 노출하지 않습니다.

RFC 7807 표준 필드와 transport correlation 필드(`type`, `title`, `status`, `code`, `detail`,
`instance`, `traceId`, `requestId`, `telemetry`)는 Problem extension으로 덮어쓸 수 없습니다.
transport가 만든 `traceId`, `requestId`, `telemetry` correlation metadata는 redaction 이후에도
복구와 로그 검색에 사용할 수 있도록 응답에 남습니다. 일반 `Error`는 로그에 남기고
`500 Internal Server Error`의 opaque 응답으로 변환합니다. 따라서 컨트롤러, guard, interceptor,
provider adapter는 사용자가 복구할 수 있는 실패를 transport까지 generic `Error`로 넘기지 말고
package-specific `Problem`으로 정규화해야 합니다.

### Pipe execution order

HTTP request arguments are resolved inside the interceptor chain immediately before controller
invocation. For every decorated argument, pipes run in deterministic scope order: application
`globalPipes`, class `@UsePipes`, method `@UsePipes`, then parameter validation pipes. Guards run
before interceptors and pipes; interceptor `before` logic wraps pipe execution, while interceptor
`after` logic runs after the controller returns. A pipe failure skips controller invocation and is
handled by the route's exception filters or the standard Problem response contract.

### Request body parse failures

`@Body()` 파라미터가 있는 라우트에서 transport는 Hono `ctx.json()`으로 요청 본문을 한 번 읽고,
성공 또는 실패한 parse promise를 같은 요청 컨텍스트에 캐시합니다. malformed JSON, 빈 JSON body,
그리고 Hono parser 경계에서 JSON으로 해석할 수 없는 unexpected content type payload는 모두
`RequestValidationProblem`으로 정규화됩니다.

이 응답은 `422 Validation Error`, `code: "protocols-rest/request-validation-failed"`를 사용하고,
`issues`는 `body.value` 경로와 `Request body must contain valid JSON` 메시지를 포함합니다. 이
계약은 body parse 실패에만 적용되며, Zod schema validation, guard, interceptor, controller,
filter가 명시적으로 던진 Croco `Problem`은 다시 감싸지 않습니다.

transport는 이 계약만으로 strict `415 Unsupported Media Type` negotiation을 추가하지 않습니다.
애플리케이션이 media type을 강제해야 한다면 라우트 앞단 middleware나 policy에서 별도로 검증해야
합니다.

### Middleware continuation and short-circuit semantics

HTTP middleware must complete exactly one pipeline contract per request:

| Outcome              | Middleware behavior                                                                   |
| -------------------- | ------------------------------------------------------------------------------------- |
| Continue             | `return next()` or `await next()` once.                                               |
| Transform downstream | `const response = await next(); return new Response(...);`                            |
| Short-circuit        | Return a native `Response`, or return `shortCircuit(reason)` without calling `next()` |

`shortCircuit(reason)` is the explicit marker for ending the chain with the current
`ctx.res.status` and `ctx.res.headers` and an empty body. Keep `reason` stable and
low-cardinality because it is written to runtime inspection details.

```typescript
import { shortCircuit, type MiddlewareFunction } from "@croco/transports-http";

const maintenanceWindow: MiddlewareFunction = (ctx) => {
  ctx.res.status = 503;
  ctx.res.headers["Retry-After"] = "60";

  return shortCircuit("maintenance-window");
};

const responseTransform: MiddlewareFunction = async (_ctx, next) => {
  const response = await next();
  if (response === undefined) {
    return;
  }

  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
};
```

If middleware returns without a native `Response`, without `shortCircuit(reason)`, and without
calling `next()`, the transport returns a `CROCO_HTTP_MIDDLEWARE_001` Problem instead of silently
turning the path into a short-circuit response. Calling `next()` more than once fails with
`CROCO_HTTP_MIDDLEWARE_002`; reuse the response from the first `next()` call instead.

Runtime inspector timelines record `middleware.short-circuit` events for native `Response`
short-circuits, explicit `shortCircuit(reason)` markers, missing `next()` failures, invalid return
values, and multiple-`next()` failures. Event details include the middleware name/index, `reason`,
and either `responseStatus` or `diagnosticCode`.

## Security Middleware Contract

`createApp`는 기본적으로 아래 4개 보안 미들웨어가 모두 등록되어 있는지 부트스트랩 시점에 검증합니다. 하나라도 누락되면 앱 생성은 fail-closed로 중단됩니다.

When calling `createApp`, include the following middleware in the `middlewares` array:

```typescript
import {
  createSlidingWindowPolicy,
  RateLimitKeyBuilder,
  RateLimiter,
  SlidingWindowInMemoryStore,
} from "@croco/ratelimit-core";
import {
  bodyLimitMiddleware,
  corsMiddleware,
  createApp,
  mb,
  rateLimitHttpMiddleware,
  securityHeadersMiddleware,
} from "@croco/transports-http";

const rateLimiter = new RateLimiter(
  new SlidingWindowInMemoryStore(),
  new RateLimitKeyBuilder(["ip"]),
);

const app = createApp({
  controllers: [UserController],
  middlewares: [
    securityHeadersMiddleware(), // HSTS, X-Frame-Options, CSP, etc.
    corsMiddleware({ origins: ["https://example.com"] }), // Cross-Origin policy
    bodyLimitMiddleware({ limit: mb(1) }), // Request body size cap
    rateLimitHttpMiddleware({
      rateLimiter,
      policy: createSlidingWindowPolicy("http", 100, 60_000),
    }), // Rate limiting
  ],
});
```

`rateLimitHttpMiddleware`의 `skipSuccessfulRequests`와 `skipFailedRequests`는 응답 상태가 결정된 뒤 성공한 limiter 체크의 refund receipt를 사용해 해당 outcome이 quota를 소비하지 않게 합니다. `skip` predicate는 기존처럼 limiter 체크 자체를 실행하지 않습니다.

`rateLimitHttpMiddleware({ failOpen })`는 quota 결과 처리와 저장소 장애 시 허용 여부에 사용하는 단일 HTTP 정책입니다.
이 값은 `RateLimiter` 생성자 기본값보다 우선하며, 저장소가 unavailable이면 runtime inspector에
`rate-limit.store-unavailable` 진단과 실제 `allowed` 또는 `rejected` 동작을 기록합니다. 기본값은 `false`입니다.

기존 앱을 단계적으로 마이그레이션해야 한다면 명시적으로 opt-out 할 수 있습니다.

```typescript
const app = createApp({
  controllers: [UserController],
  middlewares: [securityHeadersMiddleware()],
  securityValidation: "off",
});
```

기존 `unsafeSkipSecurityValidation: true` 플래그도 하위 호환용으로 지원되지만, 새 설정에는 `securityValidation: 'off'` 사용을 권장합니다.

Security validation uses explicit middleware capability metadata only. It does not inspect
`Function#toString()` output, so minified, bundled, or wrapped middleware must keep or copy the
metadata instead of depending on source text.

```typescript
import {
  declareSecurityMiddlewareCapabilities,
  getSecurityMiddlewareCapabilities,
  securityHeadersMiddleware,
  type MiddlewareFunction,
} from "@croco/transports-http";

const securityHeaders = securityHeadersMiddleware();

const wrappedSecurityHeaders: MiddlewareFunction = async (ctx, next) => {
  return securityHeaders(ctx, next);
};

declareSecurityMiddlewareCapabilities(
  wrappedSecurityHeaders,
  getSecurityMiddlewareCapabilities(securityHeaders),
);
```

Custom middleware can declare the capability it provides:

```typescript
const customCorsMiddleware = declareSecurityMiddlewareCapabilities(
  async (ctx, next) => {
    ctx.res.headers["Access-Control-Allow-Origin"] = "https://example.com";
    await next();
  },
  ["cors"],
);
```

DI graph도 HTTP bootstrap에서 같은 정책으로 검증됩니다. production 기본값은 `enforce`,
development/test 기본값은 `warn`이며, `Container.validate({ force: true })`를 실행하고
컨트롤러, guard, interceptor, filter, pipe constructor가 Croco DI에 등록되어 있는지 route
registration 전에 확인합니다.

```typescript
const app = createApp({
  controllers: [UserController],
  diValidation: "enforce",
});
```

마이그레이션 중 아직 컨트롤러나 provider를 명시적으로 등록하지 않았다면 `warn` 또는 `off`를
선택할 수 있습니다. `warn`은 동일한 diagnostic을 logger warning으로 남긴 뒤 legacy
`new type()` fallback을 허용하고, `off` 또는 `unsafeSkipDiValidation: true`는 검증과
fallback 차단을 모두 끕니다. 운영 경로에서는 `enforce`를 권장합니다.

### Required middleware

| Middleware                  | Export                   | Purpose                                                                        |
| --------------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| `securityHeadersMiddleware` | `@croco/transports-http` | Sets HTTP security headers: HSTS, X-Frame-Options, X-Content-Type-Options, CSP |
| `corsMiddleware`            | `@croco/transports-http` | Configures Cross-Origin Resource Sharing policy                                |
| `bodyLimitMiddleware`       | `@croco/transports-http` | Caps request body size to prevent payload-based DoS                            |
| `rateLimitHttpMiddleware`   | `@croco/transports-http` | Applies rate limiting to HTTP requests                                         |

All four are part of the public API and can be imported directly from `@croco/transports-http`.
Generated applications should register all four by default. Built-in middleware declares the
required security capability metadata automatically. Missing or unmarked middleware fails bootstrap
with `CROCO_HTTP_SECURITY_001` and `legacyCode: "transports-http/security-middleware-validation"`.
Consumers that matched the previous slash-form code should migrate to `CROCO_HTTP_SECURITY_001`;
the legacy value is preserved in `extensions.legacyCode` for compatibility during that migration.

`bodyLimitMiddleware` counts the actual streamed request bytes. `Content-Length` is used only for strict early rejection, so missing, malformed, chunked, or false-low headers cannot bypass the configured limit. Register it before any middleware that reads the request body; accepted bytes are replayed once to downstream JSON, text, form, and raw Request consumers. Rejections use the stable `transports-http/request-body-too-large` Problem code, include the configured `limit`, and default to HTTP 413. Setting `bodyLimitMiddleware.statusCode` changes the runtime response status; the generated Problem registry records that status as runtime-configurable while preserving 413 as its canonical default.

Use `securityValidation: 'off'` or `CROCO_HTTP_SECURITY_VALIDATION=off` only for explicit local
migration/testing fixtures where the unsafe path is the behavior under test. For custom or wrapped
middleware, prefer `declareSecurityMiddlewareCapabilities()` over disabling validation. Do not
depend on the opt-out for normal first-run or production bootstrap.

## API 레퍼런스

- 앱 런타임: `createApp`, `CrocoApp`, `ErrorHandler`, `PipelineRunner`, `RouteCompiler`
- Lambda 연동: `toLambdaHandler`, `getLambdaEvent`, `getLambdaContext`, `TypedLambdaHandler`
- 헬스체크: `HealthCheckRegistry`, `HealthCheckFunction`, `HealthCheckResult`
- 운영 endpoint: `DiagnosticsEndpointOptions`, `DiagnosticsExposureMode`, `DIAGNOSTICS_ENDPOINT_PATH`
- 본문 제한: `bodyLimitMiddleware`, `kb`, `mb`
- 압축: `compressionMiddleware`
- CORS: `corsMiddleware`
- 종료 제어: `createGracefulShutdownController`, `gracefulShutdownMiddleware`, `setupGracefulShutdown`, `isShuttingDown`,
  `resetShutdownState`
- 레이트 리밋: `rateLimitHttpMiddleware`, `createRateLimitMiddlewareFactory`
- 보안 헤더: `securityHeadersMiddleware`
- 보안 middleware capability: `declareSecurityMiddlewareCapabilities`, `getSecurityMiddlewareCapabilities`,
  `hasSecurityMiddlewareCapability`
- 타입: `AppConfig`, `CrocoHttpContext`, `CrocoRequest`, `CrocoResponse`, `LambdaEvent`, `LambdaResponse`

Node apps that pass a middleware from `createGracefulShutdownController()` or
`gracefulShutdownMiddleware()` to `createApp()` bind every `listen()` server to that lifecycle. A signal
rejects new work, drains active requests, closes the Node listener, drains the event bus, and then runs the
configured shutdown hook. Listener or hook timeout failures are logged once by the signal handler.
Signal failures set `process.exitCode` to `1`, including when no application logger is configured.
