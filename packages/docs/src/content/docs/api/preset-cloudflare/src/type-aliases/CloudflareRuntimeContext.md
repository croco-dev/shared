---
editUrl: false
next: false
prev: false
title: "CloudflareRuntimeContext"
---

> **CloudflareRuntimeContext** = `object`

:::caution[Deprecated]
Runtime callbacks should accept `CloudflareHostRuntimeContext`.
:::

## Properties

### ~~abortSignal~~

> `readonly` **abortSignal**: `AbortSignal`

---

### ~~capabilities~~

> `readonly` **capabilities**: `object`

#### ~~abortSignal~~

> `readonly` **abortSignal**: `true`

#### ~~deadline~~

> `readonly` **deadline**: `false`

#### ~~env~~

> `readonly` **env**: `true`

#### ~~filesystem~~

> `readonly` **filesystem**: `false`

#### ~~flush~~

> `readonly` **flush**: `false`

#### ~~nodeApi~~

> `readonly` **nodeApi**: `false`

#### ~~requestLifecycle~~

> `readonly` **requestLifecycle**: `true`

#### ~~shutdown~~

> `readonly` **shutdown**: `false`

#### ~~streamingResponse~~

> `readonly` **streamingResponse**: `true`

#### ~~waitUntil~~

> `readonly` **waitUntil**: `true`

***

### ~~env~~

> `readonly` **env**: `Record`\<`string`, `unknown`\>

***

### ~~native~~

> `readonly` **native**: `object`

#### ~~executionContext~~

> `readonly` **executionContext**: `ExecutionContext`

***

### ~~platform~~

> `readonly` **platform**: `"cloudflare-workers"`

***

### ~~requestId?~~

> `readonly` `optional` **requestId?**: `string`

***

### ~~waitUntil~~

> `readonly` **waitUntil**: (`promise`) => `void`

#### Parameters

##### promise

`Promise`\<`unknown`\>

#### Returns

`void`
