---
editUrl: false
next: false
prev: false
title: "RouteContractSpec"
---

> **RouteContractSpec**\<`Method`, `Path`, `Params`, `Query`, `Body`, `Response`, `Problems`\> = `object`

## Type Parameters

### Method

`Method` _extends_ [`HttpMethod`](/api/protocols-rest/src/enumerations/httpmethod/) = [`HttpMethod`](/api/protocols-rest/src/enumerations/httpmethod/)

### Path

`Path` _extends_ `string` = `string`

### Params

`Params` _extends_ `RouteParameterSchema` \| `undefined` = `RouteParameterSchema` \| `undefined`

### Query

`Query` _extends_ `RouteParameterSchema` \| `undefined` = `RouteParameterSchema` \| `undefined`

### Body

`Body` _extends_ `z.ZodType` \| `undefined` = `z.ZodType` \| `undefined`

### Response

`Response` _extends_ `z.ZodType` \| `undefined` = `z.ZodType` \| `undefined`

### Problems

`Problems` _extends_ readonly [`RouteContractProblem`](/api/protocols-rest/src/type-aliases/routecontractproblem/)[] \| `undefined` = readonly [`RouteContractProblem`](/api/protocols-rest/src/type-aliases/routecontractproblem/)[] \| `undefined`

## Properties

### body?

> `readonly` `optional` **body?**: `Body`

---

### id?

> `readonly` `optional` **id?**: `string`

---

### method

> `readonly` **method**: `Method`

---

### operationId?

> `readonly` `optional` **operationId?**: `string`

---

### params?

> `readonly` `optional` **params?**: `Params`

---

### path

> `readonly` **path**: `Path`

---

### problems?

> `readonly` `optional` **problems?**: `Problems`

---

### query?

> `readonly` `optional` **query?**: `Query`

---

### response?

> `readonly` `optional` **response?**: `Response`

---

### sourceLocation?

> `readonly` `optional` **sourceLocation?**: [`RouteContractSourceLocation`](/api/protocols-rest/src/type-aliases/routecontractsourcelocation/)
