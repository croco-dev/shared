---
editUrl: false
next: false
prev: false
title: "ApplicationRuntime"
---

Owns one isolated DI scope and one module lifecycle for a Croco application.

## Implements

- `AsyncDisposable`

## Constructors

### Constructor

> **new ApplicationRuntime**(`options?`): `ApplicationRuntime`

#### Parameters

##### options?

[`ApplicationRuntimeOptions`](/api/framework-module/src/type-aliases/applicationruntimeoptions/) \| [`CrocoApplicationDefinition`](/api/framework-module/src/type-aliases/crocoapplicationdefinition/)

#### Returns

`ApplicationRuntime`

## Properties

### scopeId

> `readonly` **scopeId**: `string`

## Methods

### \[asyncDispose\]()

> **\[asyncDispose\]**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

#### Implementation of

`AsyncDisposable.[asyncDispose]`

---

### bindHostCallback()

> **bindHostCallback**\<`TArgs`, `TResult`\>(`callback`): (...`args`) => `TResult`

#### Type Parameters

##### TArgs

`TArgs` _extends_ `unknown`[]

##### TResult

`TResult`

#### Parameters

##### callback

(...`args`) => `TResult`

#### Returns

(...`args`) => `TResult`

---

### createGraphManifest()

> **createGraphManifest**(`options?`): [`ApplicationRuntimeGraphManifest`](/api/framework-module/src/type-aliases/applicationruntimegraphmanifest/)

#### Parameters

##### options?

###### roots?

readonly [`TokenIdentifier`](/api/framework-context/src/type-aliases/tokenidentifier/)\<`unknown`\>[]

#### Returns

[`ApplicationRuntimeGraphManifest`](/api/framework-module/src/type-aliases/applicationruntimegraphmanifest/)

---

### dispose()

> **dispose**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

---

### get()

> **get**\<`T`\>(`token`): `T`

#### Type Parameters

##### T

`T`

#### Parameters

##### token

[`TokenIdentifier`](/api/framework-context/src/type-aliases/tokenidentifier/)\<`T`\>

#### Returns

`T`

---

### getContributions()

> **getContributions**\<`T`, `TKind`\>(`kind`): readonly [`ResolvedModuleContribution`](/api/framework-module/src/type-aliases/resolvedmodulecontribution/)\<`T`, `TKind`\>[]

#### Type Parameters

##### T

`T`

##### TKind

`TKind` _extends_ `string` = `string`

#### Parameters

##### kind

`TKind`

#### Returns

readonly [`ResolvedModuleContribution`](/api/framework-module/src/type-aliases/resolvedmodulecontribution/)\<`T`, `TKind`\>[]

---

### getRegisteredModules()

> **getRegisteredModules**(): readonly [`ModuleDiagnosticsSnapshot`](/api/framework-module/src/type-aliases/modulediagnosticssnapshot/)[]

#### Returns

readonly [`ModuleDiagnosticsSnapshot`](/api/framework-module/src/type-aliases/modulediagnosticssnapshot/)[]

---

### has()

> **has**\<`T`\>(`token`): `boolean`

#### Type Parameters

##### T

`T`

#### Parameters

##### token

[`TokenIdentifier`](/api/framework-context/src/type-aliases/tokenidentifier/)\<`T`\>

#### Returns

`boolean`

---

### initialize()

> **initialize**(`options?`): `Promise`\<`void`\>

#### Parameters

##### options?

[`ModuleLifecycleExecutionOptions`](/api/framework-module/src/type-aliases/modulelifecycleexecutionoptions/) = `{}`

#### Returns

`Promise`\<`void`\>

---

### run()

#### Call Signature

> **run**\<`T`\>(`fn`): `Promise`\<`T`\>

##### Type Parameters

###### T

`T`

##### Parameters

###### fn

() => `Promise`\<`T`\>

##### Returns

`Promise`\<`T`\>

#### Call Signature

> **run**\<`T`\>(`fn`): `T`

##### Type Parameters

###### T

`T`

##### Parameters

###### fn

() => `T`

##### Returns

`T`

---

### shutdown()

> **shutdown**(`options?`): `Promise`\<`void`\>

#### Parameters

##### options?

[`ModuleLifecycleExecutionOptions`](/api/framework-module/src/type-aliases/modulelifecycleexecutionoptions/) = `{}`

#### Returns

`Promise`\<`void`\>

---

### shutdownWithCleanup()

> **shutdownWithCleanup**(`cleanup`, `options?`): `Promise`\<`void`\>

#### Parameters

##### cleanup

() => `void` \| `Promise`\<`void`\>

##### options?

[`ModuleLifecycleExecutionOptions`](/api/framework-module/src/type-aliases/modulelifecycleexecutionoptions/) = `{}`

#### Returns

`Promise`\<`void`\>

---

### use()

> **use**(`module`): `void`

#### Parameters

##### module

[`ModuleOptions`](/api/framework-module/src/type-aliases/moduleoptions/)

#### Returns

`void`
