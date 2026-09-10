---
editUrl: false
next: false
prev: false
title: "Query"
---

## Call Signature

> **Query**\<`TContract`, `Name`\>(`contract`, `name`): `ContractParameterDecorator`\<[`RouteHandlerQuery`](/api/protocols-rest/src/type-aliases/routehandlerquery/)\<`TContract`\>\[`Name`\]\>

쿼리스트링 값을 메서드 인자에 바인딩합니다.

### Type Parameters

#### TContract

`TContract` _extends_ [`RouteContractSpec`](/api/protocols-rest/src/type-aliases/routecontractspec/) & `{ readonly query: RouteParameterSchema }`

#### Name

`Name` _extends_ keyof [`RouteQuery`](/api/protocols-rest/src/type-aliases/routequery/)\<`TContract`\> & `string`

### Parameters

#### contract

`TContract`

#### name

`Name`

### Returns

`ContractParameterDecorator`\<[`RouteHandlerQuery`](/api/protocols-rest/src/type-aliases/routehandlerquery/)\<`TContract`\>\[`Name`\]\>

## Schema Overload

> **Query**(`name`, `schema?`): `ParameterDecorator`

쿼리스트링 값을 메서드 인자에 바인딩합니다.

### Parameters

#### name

`string`

#### schema?

`ZodType`\<`any`, `ZodTypeDef`, `any`\>

### Returns

`ParameterDecorator`
