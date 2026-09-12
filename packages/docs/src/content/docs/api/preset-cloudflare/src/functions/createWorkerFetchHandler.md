---
editUrl: false
next: false
prev: false
title: "createWorkerFetchHandler"
---

## Call Signature

> **createWorkerFetchHandler**(`honoApp`, `options`): [`CloudflareFetchHandler`](/api/preset-cloudflare/src/type-aliases/cloudflarefetchhandler/)

:::caution[Deprecated]
Use `createCloudflareWorkersHost`.
:::

### Parameters

#### honoApp

##### fetch

[`RawHonoFetch`](/api/preset-cloudflare/src/type-aliases/rawhonofetch/)

#### options

##### mode

`"raw-hono"`

### Returns

[`CloudflareFetchHandler`](/api/preset-cloudflare/src/type-aliases/cloudflarefetchhandler/)

## Call Signature

> **createWorkerFetchHandler**(`honoApp`, `options`): [`CloudflareHostFetchHandler`](/api/preset-cloudflare/src/type-aliases/cloudflarehostfetchhandler/)

:::caution[Deprecated]
Use `createCloudflareWorkersHost`.
:::

### Parameters

#### honoApp

##### fetch

[`CloudflareHostRawHonoFetch`](/api/preset-cloudflare/src/type-aliases/cloudflarehostrawhonofetch/)

#### options

##### mode

`"raw-hono"`

### Returns

[`CloudflareHostFetchHandler`](/api/preset-cloudflare/src/type-aliases/cloudflarehostfetchhandler/)

## Call Signature

> **createWorkerFetchHandler**(`honoApp`, `options?`): [`CloudflareFetchHandler`](/api/preset-cloudflare/src/type-aliases/cloudflarefetchhandler/)

:::caution[Deprecated]
Use `createCloudflareWorkersHost`.
:::

### Parameters

#### honoApp

##### fetch

[`CloudflareAppFetch`](/api/preset-cloudflare/src/type-aliases/cloudflareappfetch/)

#### options?

[`WorkerFetchHandlerOptions`](/api/preset-cloudflare/src/type-aliases/workerfetchhandleroptions/)

### Returns

[`CloudflareFetchHandler`](/api/preset-cloudflare/src/type-aliases/cloudflarefetchhandler/)

## Call Signature

> **createWorkerFetchHandler**(`honoApp`, `options?`): [`CloudflareFetchHandler`](/api/preset-cloudflare/src/type-aliases/cloudflarefetchhandler/)

:::caution[Deprecated]
Use `createCloudflareWorkersHost`.
:::

### Parameters

#### honoApp

##### fetch

[`CloudflareAppFetch`](/api/preset-cloudflare/src/type-aliases/cloudflareappfetch/)\<`ExecutionContext` & `object`\>

#### options?

[`WorkerFetchHandlerOptions`](/api/preset-cloudflare/src/type-aliases/workerfetchhandleroptions/)

### Returns

[`CloudflareFetchHandler`](/api/preset-cloudflare/src/type-aliases/cloudflarefetchhandler/)
