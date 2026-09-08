---
editUrl: false
next: false
prev: false
title: "RlsPolicyOptions"
---

Row-Level Security(RLS)를 지원하는 Drizzle 트랜잭션 어댑터를 생성합니다.

PostgreSQL의 RLS 정책과 테넌트별 격리를 지원합니다.

## Param

**db**

Drizzle DB 인스턴스

## Param

**tenantProvider**

테넌트 ID를 제공하는 함수

## Example

```typescript
import { createRlsTxAdapter } from "@croco/tx-drizzle";

const adapter = createRlsTxAdapter(db, {
  getTenantId: () => Context.get("tenantId"),
});
```

## Properties

### adminRoles?

> `optional` **adminRoles?**: `string`[]

---

### configKey?

> `optional` **configKey?**: `string`

---

### tableName

> **tableName**: `string`

---

### tenantColumn?

> `optional` **tenantColumn?**: `string`

---

### tenantColumnType?

> `optional` **tenantColumnType?**: `"uuid"` \| `"text"`
