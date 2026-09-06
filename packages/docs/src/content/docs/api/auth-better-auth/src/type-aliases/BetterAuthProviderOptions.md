---
editUrl: false
next: false
prev: false
title: "BetterAuthProviderOptions"
---

> **BetterAuthProviderOptions** = `object`

Trust only fields whose writes are restricted to the server.

## Properties

### logger?

> `readonly` `optional` **logger?**: `Pick`\<[`ILogger`](/api/framework-context/src/interfaces/ilogger/), `"warn"`\>

Warning sink. Defaults to console.warn; claim values and user details are never logged.

---

### trustedMetadataKeys?

> `readonly` `optional` **trustedMetadataKeys?**: readonly `string`[]

Server-managed nested objects, in precedence order. Defaults to none, including privateMetadata.

---

### trustedUserFields?

> `readonly` `optional` **trustedUserFields?**: readonly [`BetterAuthClaimField`](/api/auth-better-auth/src/type-aliases/betterauthclaimfield/)[]

Additional server-managed top-level claims. The admin plugin's `role` is always trusted.
