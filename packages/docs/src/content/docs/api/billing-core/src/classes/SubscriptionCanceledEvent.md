---
editUrl: false
next: false
prev: false
title: "SubscriptionCanceledEvent"
---

구독 취소 시 발행되는 도메인 이벤트입니다.

## Extends

- [`DomainEvent`](/api/events-core/src/classes/domainevent/)

## Constructors

### Constructor

> **new SubscriptionCanceledEvent**(`tenantId`, `externalSubscriptionId`, `cancelAtPeriodEnd`, `eventId?`, `planVersionRef?`): `SubscriptionCanceledEvent`

#### Parameters

##### tenantId

`string`

##### externalSubscriptionId

`string`

##### cancelAtPeriodEnd

`boolean`

##### eventId?

`string`

##### planVersionRef?

[`PlanVersionRef`](/api/billing-core/src/type-aliases/planversionref/)

#### Returns

`SubscriptionCanceledEvent`

#### Overrides

[`DomainEvent`](/api/events-core/src/classes/domainevent/).[`constructor`](/api/events-core/src/classes/domainevent/#constructor)

## Properties

### cancelAtPeriodEnd

> `readonly` **cancelAtPeriodEnd**: `boolean`

---

### eventId

> `readonly` **eventId**: `string`

#### Inherited from

[`DomainEvent`](/api/events-core/src/classes/domainevent/).[`eventId`](/api/events-core/src/classes/domainevent/#eventid)

---

### eventName

> `readonly` **eventName**: `string`

#### Inherited from

[`DomainEvent`](/api/events-core/src/classes/domainevent/).[`eventName`](/api/events-core/src/classes/domainevent/#eventname)

---

### externalSubscriptionId

> `readonly` **externalSubscriptionId**: `string`

---

### metadata

> **metadata**: [`DomainEventMetadata`](/api/events-core/src/type-aliases/domaineventmetadata/)

#### Inherited from

[`DomainEvent`](/api/events-core/src/classes/domainevent/).[`metadata`](/api/events-core/src/classes/domainevent/#metadata)

---

### planVersionRef?

> `readonly` `optional` **planVersionRef?**: [`PlanVersionRef`](/api/billing-core/src/type-aliases/planversionref/)

---

### tenantId

> `readonly` **tenantId**: `string`

---

### timestamp

> `readonly` **timestamp**: `Date`

#### Inherited from

[`DomainEvent`](/api/events-core/src/classes/domainevent/).[`timestamp`](/api/events-core/src/classes/domainevent/#timestamp)

---

### eventName

> `readonly` `static` **eventName**: `"billing.subscription_canceled"` = `"billing.subscription_canceled"`

#### Overrides

[`DomainEvent`](/api/events-core/src/classes/domainevent/).[`eventName`](/api/events-core/src/classes/domainevent/#eventname-1)

## Methods

### fromPayload()

> `static` **fromPayload**(`payload`): `SubscriptionCanceledEvent`

#### Parameters

##### payload

`Record`\<`string`, `unknown`\>

#### Returns

`SubscriptionCanceledEvent`
