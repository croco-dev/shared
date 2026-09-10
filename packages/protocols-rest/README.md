# @croco/protocols-rest

Croco REST 프로토콜 정의 계층입니다. 컨트롤러, 라우트, 파라미터 바인딩, Guard, Pipe, Interceptor, 검증 유틸리티를 제공합니다.

## 설치

```bash
pnpm add @croco/protocols-rest @croco/framework-context reflect-metadata zod
```

## 사용법

### 컨트롤러와 라우트 정의

```typescript
import "reflect-metadata";
import { Body, Controller, Get, Param, Post } from "@croco/protocols-rest";

@Controller("/users")
class UserController {
  @Get("/:id")
  getUser(@Param("id") id: string) {
    return { id };
  }

  @Post("/")
  createUser(@Body() body: { name: string }) {
    return { id: "user-1", ...body };
  }
}
```

### Guard와 역할 검사

```typescript
import { AuthGuard, Roles, RolesGuard, UseGuards } from "@croco/protocols-rest";

@UseGuards(AuthGuard, RolesGuard)
class AdminController {
  @Roles("admin")
  removeUser() {
    return { ok: true };
  }
}
```

`AuthGuard`는 REST 요청의 `Authorization: Bearer <token>` 헤더를 검증하고 verifier가 반환한 사용자 객체를
`request.user`에 그대로 주입합니다. 사용자 객체의 `roles`, `scopes`, `permissions`, `tenantId`, `metadata`는
프로토콜 계층에서 변환하지 않습니다.

REST AuthGuard의 실패 코드는 프로토콜 범위로 고정됩니다. 헤더 누락은
`protocols-rest/auth-missing-header`, Bearer 형식 오류는 `protocols-rest/auth-invalid-header-format`,
토큰 검증 실패 또는 verifier의 falsy 반환은 `protocols-rest/auth-invalid-token`, verifier 장애는
`protocols-rest/auth-verifier-unavailable` Problem으로 보고됩니다. verifier가 Croco `Problem`을 직접 던진
경우에는 해당 Problem을 보존합니다. 공개 route 우회는 auth-core의 `@Public` 메타데이터가 아니라 해당
route에 guard를 설치하지 않는 방식으로 표현합니다.

### Zod 기반 검증

```typescript
import { createValidationPipe, validateRequest } from "@croco/protocols-rest";
import { z } from "zod";

const schema = z.object({ page: z.coerce.number().int().min(1) });
const pipe = createValidationPipe(schema);
const page = validateRequest(schema, { page: "1" });
```

### Repeated HTTP parameters

`HttpContext.query(name)` returns `string | string[] | undefined`: a single query key remains a
string, while repeated keys such as `?tag=a&tag=b` are preserved as `string[]`. Existing code that
uses this context API must narrow or validate the value before using it as a scalar.

Named `@Query("tag")` parameters without an explicit schema retain the generated optional-scalar
contract and reject repeated values. Declare a Zod array schema when the controller parameter is
intended to accept repeated keys.

When `@Query()` uses a Zod array schema, a single query value is normalized to a one-item array and
repeated values remain an array. Repeated values for scalar query schemas fail validation. For
`@Header()` array schemas, the Fetch/Hono comma-delimited header value is split and trimmed before
Zod validation; scalar header schemas retain the original string behavior.

### 스키마 단일 출처

`defineRouteSchema`는 DTO 타입, 런타임 검증, 응답 스키마, OpenAPI/RPC 산출물의 출처를 하나의
route schema 객체로 모읍니다. 새 외부 스키마 의존성을 추가하지 않고 기존 Zod 기반 REST 검증
경로를 사용합니다.

```typescript
import {
  Body,
  Controller,
  Post,
  ResponseSchema,
  defineRouteSchema,
  type InferRouteSchemaRequest,
  type InferRouteSchemaResponse,
} from "@croco/protocols-rest";
import { z } from "zod";

const createUserRoute = defineRouteSchema({
  request: {
    body: z.object({
      name: z.string().min(1),
      email: z.string().email(),
    }),
  },
  response: z.object({
    id: z.string().uuid(),
    name: z.string(),
    email: z.string().email(),
  }),
});

type CreateUserBody = InferRouteSchemaRequest<typeof createUserRoute>["body"];
type CreateUserResponse = InferRouteSchemaResponse<typeof createUserRoute>;

@Controller("/users")
class UserController {
  @Post("/")
  @ResponseSchema(createUserRoute.response)
  createUser(@Body(createUserRoute.request.body) body: CreateUserBody): CreateUserResponse {
    return { id: "4ea573de-cfb9-4696-bc48-216f19f44300", ...body };
  }
}
```

### 타입 기반 라우트 계약

```typescript
import {
  Body,
  Controller,
  defineRouteContract,
  Get,
  HttpMethod,
  Param,
  Post,
} from "@croco/protocols-rest";
import { z } from "zod";

const userSchema = z.object({ id: z.string(), name: z.string() });
const createUserSchema = z.object({ name: z.string() });
type User = z.input<typeof userSchema>;
type CreateUser = z.output<typeof createUserSchema>;

const getUser = defineRouteContract({
  method: HttpMethod.GET,
  path: "/users/:id",
  params: z.object({ id: z.string() }),
  response: userSchema,
});

const createUser = defineRouteContract({
  method: HttpMethod.POST,
  path: "/users",
  body: createUserSchema,
  response: userSchema,
});

@Controller("/users")
class UserController {
  @Get(getUser)
  find(@Param(getUser, "id") id: string): User {
    return { id, name: "Ada" };
  }

  @Post(createUser)
  create(@Body(createUser) body: CreateUser): User {
    return { id: "user-1", name: body.name };
  }
}
```

`defineRouteContract`는 path params, query, body, response, Problem union을 TypeScript 계약으로 연결합니다. 계약을 전달한 `@Param`, `@Query`, `@Body`는 Zod가 파싱한 출력 타입이 컨트롤러 파라미터 타입에 할당 가능한지 검사합니다. 따라서 coercion, default, transform, preprocess 이후의 출력이 기준이며 optional, nullable, union도 전체 출력 범위를 받아야 합니다. branded 출력은 같은 brand뿐 아니라 안전한 wider 타입도 받을 수 있고 `unknown`은 허용되지만, annotation의 `any`와 `never`는 strict 계약을 우회할 수 없습니다. `z.any()`처럼 파싱 결과가 unconstrained인 schema는 `unknown` annotation만 허용합니다. `z.never()`는 값을 전달하지 않으며 안전한 wider annotation으로만 표현합니다.

Route contract 타입은 Zod schema의 입력과 출력을 다음 네 라이프사이클 슬롯으로 분리합니다.

| 라이프사이클 슬롯    | 타입 헬퍼                                                                                | Zod 의미                     |
| -------------------- | ---------------------------------------------------------------------------------------- | ---------------------------- |
| 클라이언트 요청      | `RouteClientRequest`, `RouteClientPathParams`, `RouteClientQuery`, `RouteClientBody`     | request schema의 `z.input`   |
| 핸들러 입력          | `RouteHandlerRequest`, `RouteHandlerPathParams`, `RouteHandlerQuery`, `RouteHandlerBody` | request schema의 `z.output`  |
| 핸들러 반환          | `RouteHandlerReturn`                                                                     | response schema의 `z.input`  |
| wire/클라이언트 응답 | `RouteWireResponse`, `RouteClientResponse`                                               | response schema의 `z.output` |

예를 들어 `response: z.string().transform((value) => value.length)`인 계약은 컨트롤러에서 `string`을 반환하고, 응답 schema를 파싱한 뒤 클라이언트에는 `number`를 노출합니다. `RouteMethodReturn`과 `RouteContractResult`는 핸들러 반환 슬롯을 사용합니다. `RouteResponse`는 기존 코드와 생성 클라이언트의 의미를 보존하기 위해 wire 응답 슬롯의 호환 alias입니다. 요청의 기존 `RoutePathParams`, `RouteQuery`, `RouteBody`, `RouteContractRequest`는 핸들러 입력 슬롯의 호환 alias입니다.

응답 schema는 컨트롤러가 반환한 pre-transform 값을 `validateResponse` 또는 schema parsing 경계에서 검증하고 변환합니다. `@croco/transports-http`는 컨트롤러 반환 직후 이 경계를 적용하며, 다른 전송 adapter는 동일한 응답 검증 경계를 명시적으로 설치해야 합니다. OpenAPI와 RPC 생성기는 같은 contract schema metadata를 소비하며 JSON으로 안전하게 표현할 수 없는 transform은 기존 strict schema diagnostic으로 거부합니다.

계약 기반 파라미터 데코레이터는 public instance method 전용입니다. constructor, static, private, protected method는 controller parameter metadata의 안정적인 소유 경계를 제공하지 않으므로 거부합니다. generic method도 concrete annotation을 제공하지 않으므로 typecheck에서 거부합니다. overloaded method는 TypeScript가 decorated implementation annotation을 숨기므로 계약 기반 파라미터와 response-bearing HTTP 데코레이터를 `static-misuse:check`에서 거부합니다. 이 대상이 필요하면 generic/overload가 아닌 public method를 얇은 controller adapter로 두고 내부 메서드에 위임하세요.

response schema가 있는 contract를 `@Get`, `@Post` 같은 HTTP 데코레이터에 전달하면 동기·비동기 메서드의 실제 반환 주석을 `RouteHandlerReturn`과 대조합니다. response transform은 wire 출력이 아니라 handler-return 입력을 기준으로 검사합니다. 데코레이터 비교에서는 Zod가 파싱할 수 있는 readonly 배열을 중첩 위치에서도 허용하되, `RouteHandlerReturn` 자체는 `z.input`을 그대로 유지하고 튜플 길이, 원소 타입, class instance identity를 포함한 응답 구조를 검사합니다. runtime union인 contract는 모든 response-bearing 멤버가 받을 수 있는 반환 주석을 요구합니다. 반환 주석의 `any`, `never`, `void`는 strict 검사를 우회하거나 반환값을 숨기므로 허용하지 않습니다. `unknown`은 response schema의 handler-return 슬롯이 `unknown`을 받는 경우에만 허용합니다. response schema가 없는 contract에는 검증할 반환 계약이 없으므로 기존 broad 경로를 유지합니다.

`@Get(createUser)`처럼 HTTP 메서드가 맞지 않거나 `@Param(getUser, "userId")`처럼 path에 없는 이름, response schema와 맞지 않는 반환 타입은 typecheck 단계에서 실패합니다. 기존 `@Get("/users")`와 `@Query("page", z.coerce.number())` 같은 string/schema 오버로드는 호환성 경로로 유지되어 메서드 반환이나 파라미터 주석을 제한하지 않습니다. `RouteMethodReturn`, `RouteParam`, `RouteQueryParam`, `RouteBody`는 고급 타입 조합과 기존 코드 호환을 위해 계속 제공됩니다. `RouteContract.path`는 컨트롤러 접두사를 포함한 전체 경로와 상대 경로를 모두 지원합니다. `@Controller("/api/v1")`에서 계약 경로가 `/users`이면 최종 경로는 `/api/v1/users`입니다. 계약 경로가 이미 `/api/v1/users`이거나 접두사 `/api/v1`과 같으면 중복으로 붙이지 않습니다. 접두사 비교는 경로 세그먼트 경계를 기준으로 하므로 `/api/v10/users`는 `/api/v1` 하위 경로로 취급하지 않습니다. 접두사가 없는 컨트롤러는 계약 경로를 그대로 사용합니다. 런타임 값 검증과 metadata 형식은 기존처럼 Zod schema와 pipe가 담당합니다. Route contract는 아직 headers schema를 소유하지 않으므로 `@Header`는 명시적 schema를 받는 기존 경로를 유지하며 네 슬롯의 aggregate request 타입에는 headers가 포함되지 않습니다.

### 기존 라우트 설정 타입에서 마이그레이션

런타임에서 소비되지 않던 `TypedRouteConfig`, `ApiEndpoint`와 관련 추론 타입은 제거되었습니다. 다음 대응 관계로 `defineRouteContract` 기반 계약으로 옮기세요.

- `TypedRouteConfig`, `ApiEndpoint` → `defineRouteContract`와 `RouteContractSpec`
- `TypedRouteHandler` → `RouteContractHandler`
- 전체 요청 객체 → `RouteContractRequest`
- 전체 path params 객체 → `RoutePathParams`; `RouteParam`은 이름 하나를 지정한 path param에만 사용
- 클라이언트 응답 값 → `RouteResponse` 또는 `RouteClientResponse`; controller 반환값 → `RouteHandlerReturn`; 동기 또는 `Promise`를 허용하는 handler 반환값 → `RouteContractResult`

이 마이그레이션은 drop-in 교체가 아닙니다. 제거된 요청 추론 타입과 `RouteContractRequest`는 schema가 없는 body, query, params의 타입 의미가 서로 다릅니다. `inputSchemas` 전체를 대신하는 단일 필드도 없습니다. 기존 body, query, path schema는 각각 `body`, `query`, `params`로 이동해야 합니다. 단, `RouteContractSpec.query`와 `RouteContractSpec.params`는 `z.object(...)` 형태의 객체 스키마만 받습니다. 기존 query 또는 path schema가 scalar, array, union, transform이라면 각 값을 이름 있는 객체 필드로 재구성한 뒤 옮겨야 하며 직접 대입할 수 없습니다. `inputSchemas.headers`에 대응하는 `RouteContractSpec` 필드는 현재 없으며, 이 설정은 기존에도 런타임에서 소비되지 않았습니다. Header schema 지원은 별도의 런타임 소유 계약으로 설계되어야 하므로 마이그레이션 과정에서 조용히 생략하지 마세요.

## API 레퍼런스

- 데코레이터: `Controller`, `Get`, `Post`, `Put`, `Patch`, `Delete`, `Options`, `Head`, `All`
- 파라미터 바인딩: `Param`, `Query`, `Header`, `Body`, `Ctx`, `Raw`
- 라이프사이클: `UseGuards`, `UsePipes`, `UseInterceptors`, `UseFilters`, `Roles`
- 기본 구현체: `AuthGuard`, `RolesGuard`, `LoggingInterceptor`, `HttpExceptionFilter`, `ValidationPipe`
- 메타데이터 조회: `getControllerMeta`, `getRouteMeta`, `getParamsMeta`, `getGuards`, `getPipes`, `getInterceptors`, `getFilters`, `isController`
- 검증 유틸리티: `createValidator`, `validateRequest`, `validateResponse`, `createValidationPipe`
- 검증 Problem: `ValidationProblem`, `RequestValidationProblem`, `ResponseValidationProblem`
- 스키마 계약: `defineRouteSchema`, `InferRouteSchemaRequest`, `InferRouteSchemaResponse`, `defineRouteContract`, `routeParam`, `routeParamSchema`, `routeQueryParam`, `routeQueryParamSchema`, `routePathParamsSchema`, `routeQuerySchema`, `routeBodySchema`, `routeResponseSchema`
- 타입: `ExecutionContext`, `PipeTransform`, `ExceptionFilter`, `CallHandler`, `RouteSchema`, `RouteHandler`, `RouteContractSpec`, `RouteContractSourceLocation`, `RouteClientRequest`, `RouteHandlerRequest`, `RouteContractRequest`, `RouteContractResult`, `RouteClientBody`, `RouteHandlerBody`, `RouteBody`, `RouteClientPathParams`, `RouteHandlerPathParams`, `RoutePathParams`, `RouteClientQuery`, `RouteHandlerQuery`, `RouteHandlerReturn`, `RouteWireResponse`, `RouteClientResponse`, `RouteResponse`, `RouteMethodReturn`, `RouteParam`, `RouteQueryParam`
