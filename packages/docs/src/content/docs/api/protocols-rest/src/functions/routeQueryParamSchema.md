---
editUrl: false
next: false
prev: false
title: "routeQueryParamSchema"
---

> **routeQueryParamSchema**\<`TContract`, `Name`\>(`contract`, `name`): `RouteParameterObject`\<`TContract`\[`"query"`\]\>\[`"shape"`\]\[`Name`\]

## Type Parameters

### TContract

`TContract` _extends_ [`RouteContractSpec`](/api/protocols-rest/src/type-aliases/routecontractspec/) & `{ readonly query: RouteParameterSchema }`

### Name

`Name` _extends_ keyof `RouteParameterObject`\<`TContract`\[`"query"`\]\>\[`"shape"`\] & `string`

## Parameters

### contract

`TContract`

### name

`Name`

## Returns

`RouteParameterObject`\<`TContract`\[`"query"`\]\>\[`"shape"`\]\[`Name`\]
