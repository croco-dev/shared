---
editUrl: false
next: false
prev: false
title: "IdempotencyExecutionRequest"
---

> **IdempotencyExecutionRequest** = `object`

## Properties

### isRetryable?

> `readonly` `optional` **isRetryable?**: (`error`) => `boolean`

Overrides handler failure retryability; audit and commit recovery are unchanged.

#### Parameters

##### error

`unknown`

#### Returns

`boolean`

---

### key

> `readonly` **key**: [`DerivedIdempotencyKey`](/api/idempotency-core/src/type-aliases/derivedidempotencykey/)

---

### metadata?

> `readonly` `optional` **metadata?**: `Record`\<`string`, `unknown`\>

---

### ttlMs?

> `readonly` `optional` **ttlMs?**: `number`
