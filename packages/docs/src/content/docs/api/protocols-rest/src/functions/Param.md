---
editUrl: false
next: false
prev: false
title: "Param"
---

## Call Signature

> **Param**\<`TContract`, `Name`\>(`contract`, `name`): `ContractParameterDecorator`\<[`RouteHandlerPathParams`](/api/protocols-rest/src/type-aliases/routehandlerpathparams/)\<`TContract`\>\[`Name`\]\>

경로 파라미터를 메서드 인자에 바인딩합니다.

### Type Parameters

#### TContract

`TContract` _extends_ [`RouteContractSpec`](/api/protocols-rest/src/type-aliases/routecontractspec/) & `{ readonly params: RouteParameterSchema }`

#### Name

`Name` _extends_ keyof [`RoutePathParams`](/api/protocols-rest/src/type-aliases/routepathparams/)\<`TContract`\> & `string`

### Parameters

#### contract

`TContract`

#### name

`Name`

### Returns

`ContractParameterDecorator`\<[`RouteHandlerPathParams`](/api/protocols-rest/src/type-aliases/routehandlerpathparams/)\<`TContract`\>\[`Name`\]\>

## Schema Overload

> **Param**(`name`, `schema?`): `ParameterDecorator`

경로 파라미터를 메서드 인자에 바인딩합니다.

### Parameters

#### name

`string`

#### schema?

`ZodType`\<`any`, `ZodTypeDef`, `any`\>

### Returns

`ParameterDecorator`
