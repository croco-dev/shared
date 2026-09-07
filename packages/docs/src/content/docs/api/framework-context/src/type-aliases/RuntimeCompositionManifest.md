---
editUrl: false
next: false
prev: false
title: "RuntimeCompositionManifest"
---

> **RuntimeCompositionManifest**\<`TPlatform`\> = `object`

## Type Parameters

### TPlatform

`TPlatform` _extends_ [`RuntimePlatform`](/api/framework-context/src/type-aliases/runtimeplatform/) = [`RuntimePlatform`](/api/framework-context/src/type-aliases/runtimeplatform/)

## Properties

### buildTarget

> `readonly` **buildTarget**: [`RuntimeBuildTargetManifest`](/api/framework-context/src/type-aliases/runtimebuildtargetmanifest/)

---

### host

> `readonly` **host**: [`RuntimeHostManifest`](/api/framework-context/src/type-aliases/runtimehostmanifest/)\<`TPlatform`\>

---

### transports

> `readonly` **transports**: readonly [`RuntimeTransportManifest`](/api/framework-context/src/type-aliases/runtimetransportmanifest/)[]
