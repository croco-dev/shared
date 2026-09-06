---
editUrl: false
next: false
prev: false
title: "TxAdapter"
---

루트 트랜잭션과 savepoint 생성을 추상화하는 어댑터 계약입니다.

## Type Parameters

### TClient

`TClient`

### TOptions

`TOptions` = `unknown`

## Methods

### savepoint()

> **savepoint**\<`T`\>(`client`, `fn`, `options?`, `signal?`): `Promise`\<`T`\>

The signal follows the same commit-aware boundary as transaction(): finish rollback and reject
with `TransactionRollbackConfirmedProblem` before release, or fulfill after release completes.

#### Type Parameters

##### T

`T`

#### Parameters

##### client

`TClient`

##### fn

(`client`) => `Promise`\<`T`\>

##### options?

`TOptions`

##### signal?

`AbortSignal`

#### Returns

`Promise`\<`T`\>

---

### supportsSavepoint()

> **supportsSavepoint**(`client?`): `boolean`

Check the active transaction client when capability depends on the driver or connection.

#### Parameters

##### client?

`TClient`

#### Returns

`boolean`

---

### transaction()

> **transaction**\<`T`\>(`fn`, `options?`, `signal?`): `Promise`\<`T`\>

The signal marks the transaction deadline. An adapter that cancels safely must finish rollback
and reject with `TransactionRollbackConfirmedProblem` whose cause is `signal.reason`. Once this
promise fulfills, TxManager treats the transaction as committed even if the signal fired while
the adapter was waiting for the commit response.

#### Type Parameters

##### T

`T`

#### Parameters

##### fn

(`client`) => `Promise`\<`T`\>

##### options?

`TOptions`

##### signal?

`AbortSignal`

#### Returns

`Promise`\<`T`\>
