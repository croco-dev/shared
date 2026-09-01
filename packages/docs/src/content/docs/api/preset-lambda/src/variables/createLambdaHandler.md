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

`Hono`\<`BlankEnv`, `BlankSchema`, `"/"`\> \| \{ `fetch`: (`req`) => `Promise`\<`Response`\>; \}

### options?

[`LambdaHandlerOptions`](/api/transports-http/src/type-aliases/lambdahandleroptions/) = `{}`

## Returns

[`LambdaHandler`](/api/preset-lambda/src/type-aliases/lambdahandler/)
