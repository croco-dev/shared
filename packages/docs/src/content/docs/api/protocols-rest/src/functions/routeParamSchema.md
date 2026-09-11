---
editUrl: false
next: false
prev: false
title: "routeParamSchema"
---

> **routeParamSchema**\<`TContract`, `Name`\>(`contract`, `name`): `RouteParameterObject`\<`TContract`\[`"params"`\]\>\[`"shape"`\]\[`Name`\]

## Type Parameters

### TContract

`TContract` _extends_ [`RouteContractSpec`](/api/protocols-rest/src/type-aliases/routecontractspec/) & `{ readonly params: RouteParameterSchema }`

### Name

`Name` _extends_ [`RoutePathParamName`](/api/protocols-rest/src/type-aliases/routepathparamname/)\<`TContract`\[`"path"`\]\> & keyof `RouteParameterObject`\<`TContract`\[`"params"`\]\>\[`"shape"`\] & `string`

## Parameters

### contract

`TContract`

### name

`Name`

## Returns

`RouteParameterObject`\<`TContract`\[`"params"`\]\>\[`"shape"`\]\[`Name`\]
