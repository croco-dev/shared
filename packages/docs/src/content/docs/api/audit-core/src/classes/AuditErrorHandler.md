---
editUrl: false
next: false
prev: false
title: "AuditErrorHandler"
---

감사 로그 쓰기 실패 시 재시도하는 에러 핸들러와 헬퍼입니다.

## Constructors

### Constructor

> **new AuditErrorHandler**(`config?`): `AuditErrorHandler`

#### Parameters

##### config?

`Partial`\<`AuditErrorHandlerConfig`\> = `{}`

#### Returns

`AuditErrorHandler`

## Methods

### executeWithRetry()

> **executeWithRetry**\<`T`\>(`operation`, `context`, `signal?`): `Promise`\<`T` \| `undefined`\>

#### Type Parameters

##### T

`T`

#### Parameters

##### operation

() => `Promise`\<`T`\>

##### context

`string`

##### signal?

`AbortSignal`

#### Returns

`Promise`\<`T` \| `undefined`\>
