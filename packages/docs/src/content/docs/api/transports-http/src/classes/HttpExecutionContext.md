---
editUrl: false
next: false
prev: false
title: "HttpExecutionContext"
---

Guard, Interceptor, Filter가 사용할 REST 실행 컨텍스트 구현체입니다.

## Implements

- [`ExecutionContext`](/api/protocols-rest/src/interfaces/executioncontext/)

## Constructors

### Constructor

> **new HttpExecutionContext**(`ctx`, `controllerClass`, `handlerName`): `HttpExecutionContext`

#### Parameters

##### ctx

[`CrocoHttpContext`](/api/transports-http/src/interfaces/crocohttpcontext/)

##### controllerClass

[`Constructor`](/api/protocols-rest/src/type-aliases/constructor/)

##### handlerName

`string` \| `symbol`

#### Returns

`HttpExecutionContext`

## Methods

### get()

> **get**\<`T`\>(`key`): `T` \| `undefined`

#### Type Parameters

##### T

`T`

#### Parameters

##### key

`string`

#### Returns

`T` \| `undefined`

---

### getClass()

> **getClass**(): [`Constructor`](/api/protocols-rest/src/type-aliases/constructor/)

컨트롤러 클래스 참조

#### Returns

[`Constructor`](/api/protocols-rest/src/type-aliases/constructor/)

#### Implementation of

[`ExecutionContext`](/api/protocols-rest/src/interfaces/executioncontext/).[`getClass`](/api/protocols-rest/src/interfaces/executioncontext/#getclass)

---

### getHandler()

> **getHandler**(): `string` \| `symbol`

핸들러 메서드 이름

#### Returns

`string` \| `symbol`

#### Implementation of

[`ExecutionContext`](/api/protocols-rest/src/interfaces/executioncontext/).[`getHandler`](/api/protocols-rest/src/interfaces/executioncontext/#gethandler)

---

### getHttpContext()

> **getHttpContext**(): [`CrocoHttpContext`](/api/transports-http/src/interfaces/crocohttpcontext/)

#### Returns

[`CrocoHttpContext`](/api/transports-http/src/interfaces/crocohttpcontext/)

---

### getMethod()

> **getMethod**(): `string`

HTTP 메서드 (GET, POST 등)

#### Returns

`string`

#### Implementation of

[`ExecutionContext`](/api/protocols-rest/src/interfaces/executioncontext/).[`getMethod`](/api/protocols-rest/src/interfaces/executioncontext/#getmethod)

---

### getPath()

> **getPath**(): `string`

요청 URL 경로

#### Returns

`string`

#### Implementation of

[`ExecutionContext`](/api/protocols-rest/src/interfaces/executioncontext/).[`getPath`](/api/protocols-rest/src/interfaces/executioncontext/#getpath)

---

### getRequest()

> **getRequest**(): `Request`

원본 HTTP Request 객체

#### Returns

`Request`

#### Implementation of

[`ExecutionContext`](/api/protocols-rest/src/interfaces/executioncontext/).[`getRequest`](/api/protocols-rest/src/interfaces/executioncontext/#getrequest)

---

### set()

> **set**\<`T`\>(`key`, `value`): `void`

#### Type Parameters

##### T

`T`

#### Parameters

##### key

`string`

##### value

`T`

#### Returns

`void`
