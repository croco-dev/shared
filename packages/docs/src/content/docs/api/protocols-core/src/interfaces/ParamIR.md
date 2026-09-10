---
editUrl: false
next: false
prev: false
title: "ParamIR"
---

## Properties

### contractSchema?

> `optional` **contractSchema?**: `ZodType`\<`any`, `ZodTypeDef`, `any`\>

---

### index?

> `optional` **index?**: `number`

Original controller method argument position. Optional for compatibility with
pre-existing serialized RouteIR artifacts that only preserve declaration order.

---

### kind

> **kind**: `"path"` \| `"body"` \| `"query"` \| `"header"` \| `"ctx"`

---

### name

> **name**: `string`

---

### schema

> **schema**: `ZodType`\<`any`, `ZodTypeDef`, `any`\> \| `null`

---

### sourceLocation?

> `optional` **sourceLocation?**: [`RouteContractSourceLocation`](/api/protocols-core/src/type-aliases/routecontractsourcelocation/)
