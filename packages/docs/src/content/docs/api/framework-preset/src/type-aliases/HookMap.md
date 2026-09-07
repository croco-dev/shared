---
editUrl: false
next: false
prev: false
title: "HookMap"
---

> **HookMap** = `object`

## Properties

### build:after?

> `readonly` `optional` **build:after?**: (`result`) => `Promise`\<`void`\> \| `void`

#### Parameters

##### result

###### outputDir

`string`

###### success

`boolean`

#### Returns

`Promise`\<`void`\> \| `void`

---

### build:before?

> `readonly` `optional` **build:before?**: (`config`) => `Promise`\<[`CrocoBuildTargetConfig`](/api/framework-preset/src/type-aliases/crocobuildtargetconfig/)\> \| [`CrocoBuildTargetConfig`](/api/framework-preset/src/type-aliases/crocobuildtargetconfig/)

#### Parameters

##### config

[`CrocoBuildTargetConfig`](/api/framework-preset/src/type-aliases/crocobuildtargetconfig/)

#### Returns

`Promise`\<[`CrocoBuildTargetConfig`](/api/framework-preset/src/type-aliases/crocobuildtargetconfig/)\> \| [`CrocoBuildTargetConfig`](/api/framework-preset/src/type-aliases/crocobuildtargetconfig/)

---

### dev:start?

> `readonly` `optional` **dev:start?**: () => `Promise`\<`void`\> \| `void`

#### Returns

`Promise`\<`void`\> \| `void`
