---
editUrl: false
next: false
prev: false
title: "DrizzleTxAdapterOptions"
---

Drizzle DB 인스턴스를 받아 TxAdapter를 생성합니다.

## Param

**db**

Drizzle DB 인스턴스 (PostgreSQL, MySQL, SQLite 지원)

## Example

```typescript
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createDrizzleTxAdapter } from "@croco/tx-drizzle";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);
const adapter = createDrizzleTxAdapter(db);
```

## Properties

### onConnectionInvalidate?

> `optional` **onConnectionInvalidate?**: (`client`, `reason`) => `void` \| `Promise`\<`void`\>

Optional hook invoked when a transaction connection is invalidated or aborted
with active in-flight operations, ensuring the socket is discarded/destroyed
and never returned to the connection pool in a tainted state.

#### Parameters

##### client

`unknown`

##### reason

`Error`

#### Returns

`void` \| `Promise`\<`void`\>

---

### operationDrainTimeoutMs?

> `optional` **operationDrainTimeoutMs?**: `number`

Maximum time in milliseconds to wait for in-flight socket operations to settle
after an abort signal fires before considering the connection permanently stuck.

#### Default

```ts
5000;
```

---

### supportsSavepoint?

> `optional` **supportsSavepoint?**: `boolean`

Disable savepoints for drivers whose transaction method does not support nested execution.
