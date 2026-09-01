---
editUrl: false
next: false
prev: false
title: "createLambdaHandler"
---

> `const` **createLambdaHandler**: (`honoApp`, `options`) => [`LambdaHandler`](/api/preset-lambda/src/type-aliases/lambdahandler/) = `createLambdaHost`

:::caution[Deprecated]
Use `createLambdaHost`.
:::

## Parameters

### honoApp

[`LambdaFetchApplication`](/api/preset-lambda/src/type-aliases/lambdafetchapplication/) \| `Hono`\<`BlankEnv`, `BlankSchema`, `"/"`\>

### options?

[`LambdaHandlerOptions`](/api/transports-http/src/type-aliases/lambdahandleroptions/) = `{}`

## Returns

[`LambdaHandler`](/api/preset-lambda/src/type-aliases/lambdahandler/)
