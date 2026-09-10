---
editUrl: false
next: false
prev: false
title: "DomainPolicyStore"
---

도메인 정책 저장소 추상 계약입니다.

## Extended by

- [`InMemoryDomainPolicyStore`](/api/invitation-core/src/classes/inmemorydomainpolicystore/)
- [`DrizzleDomainPolicyStore`](/api/invitation-drizzle/src/classes/drizzledomainpolicystore/)

## Constructors

### Constructor

> **new DomainPolicyStore**(): `DomainPolicyStore`

#### Returns

`DomainPolicyStore`

## Methods

### claimAutoJoinEvent()

> `abstract` **claimAutoJoinEvent**(`tenantId`, `idempotencyKey`, `claimId`, `claimExpiresAt`, `expectedEventId`): `Promise`\<[`DomainAutoJoinIntent`](/api/invitation-core/src/type-aliases/domainautojoinintent/) \| `null`\>

#### Parameters

##### tenantId

`string`

##### idempotencyKey

`string`

##### claimId

`string`

##### claimExpiresAt

`Date`

##### expectedEventId

`string`

#### Returns

`Promise`\<[`DomainAutoJoinIntent`](/api/invitation-core/src/type-aliases/domainautojoinintent/) \| `null`\>

---

### completeAutoJoinEvent()

> `abstract` **completeAutoJoinEvent**(`tenantId`, `idempotencyKey`, `claimId`): `Promise`\<[`DomainAutoJoinIntent`](/api/invitation-core/src/type-aliases/domainautojoinintent/) \| `null`\>

#### Parameters

##### tenantId

`string`

##### idempotencyKey

`string`

##### claimId

`string`

#### Returns

`Promise`\<[`DomainAutoJoinIntent`](/api/invitation-core/src/type-aliases/domainautojoinintent/) \| `null`\>

---

### completeAutoJoinMembership()

> `abstract` **completeAutoJoinMembership**(`tenantId`, `idempotencyKey`, `membership`, `expectedEventId`): `Promise`\<[`DomainAutoJoinIntent`](/api/invitation-core/src/type-aliases/domainautojoinintent/) \| `null`\>

#### Parameters

##### tenantId

`string`

##### idempotencyKey

`string`

##### membership

[`Membership`](/api/membership-core/src/type-aliases/membership/)

##### expectedEventId

`string`

#### Returns

`Promise`\<[`DomainAutoJoinIntent`](/api/invitation-core/src/type-aliases/domainautojoinintent/) \| `null`\>

---

### createAutoJoinIntent()

> `abstract` **createAutoJoinIntent**(`input`): `Promise`\<[`DomainAutoJoinIntentCreation`](/api/invitation-core/src/type-aliases/domainautojoinintentcreation/)\>

#### Parameters

##### input

[`DomainAutoJoinIntent`](/api/invitation-core/src/type-aliases/domainautojoinintent/)

#### Returns

`Promise`\<[`DomainAutoJoinIntentCreation`](/api/invitation-core/src/type-aliases/domainautojoinintentcreation/)\>

---

### delete()

> `abstract` **delete**(`tenantId`, `domain`): `Promise`\<`void`\>

#### Parameters

##### tenantId

`string`

##### domain

`string`

#### Returns

`Promise`\<`void`\>

---

### deleteUncommittedAutoJoinIntent()

> `abstract` **deleteUncommittedAutoJoinIntent**(`tenantId`, `idempotencyKey`, `expectedEventId`): `Promise`\<`void`\>

#### Parameters

##### tenantId

`string`

##### idempotencyKey

`string`

##### expectedEventId

`string`

#### Returns

`Promise`\<`void`\>

---

### findAllByTenant()

> `abstract` **findAllByTenant**(`tenantId`): `Promise`\<[`DomainPolicy`](/api/invitation-core/src/type-aliases/domainpolicy/)[]\>

#### Parameters

##### tenantId

`string`

#### Returns

`Promise`\<[`DomainPolicy`](/api/invitation-core/src/type-aliases/domainpolicy/)[]\>

---

### findAutoJoinIntent()

> `abstract` **findAutoJoinIntent**(`tenantId`, `idempotencyKey`): `Promise`\<[`DomainAutoJoinIntent`](/api/invitation-core/src/type-aliases/domainautojoinintent/) \| `null`\>

#### Parameters

##### tenantId

`string`

##### idempotencyKey

`string`

#### Returns

`Promise`\<[`DomainAutoJoinIntent`](/api/invitation-core/src/type-aliases/domainautojoinintent/) \| `null`\>

---

### findByTenantAndDomain()

> `abstract` **findByTenantAndDomain**(`tenantId`, `domain`): `Promise`\<[`DomainPolicy`](/api/invitation-core/src/type-aliases/domainpolicy/) \| `null`\>

#### Parameters

##### tenantId

`string`

##### domain

`string`

#### Returns

`Promise`\<[`DomainPolicy`](/api/invitation-core/src/type-aliases/domainpolicy/) \| `null`\>

---

### releaseAutoJoinEvent()

> `abstract` **releaseAutoJoinEvent**(`tenantId`, `idempotencyKey`, `claimId`): `Promise`\<`void`\>

#### Parameters

##### tenantId

`string`

##### idempotencyKey

`string`

##### claimId

`string`

#### Returns

`Promise`\<`void`\>

---

### renewAutoJoinIntent()

> `abstract` **renewAutoJoinIntent**(`input`, `expectedEventId`): `Promise`\<[`DomainAutoJoinIntentCreation`](/api/invitation-core/src/type-aliases/domainautojoinintentcreation/)\>

Atomically replaces the tenant/key intent only when its event ID matches,
its event is completed, and its membership is non-null.
Returns created=true only for the winner; otherwise returns the current intent.
Throws DomainAutoJoinRecoveryProblem when the intent no longer exists.

#### Parameters

##### input

[`DomainAutoJoinIntent`](/api/invitation-core/src/type-aliases/domainautojoinintent/)

##### expectedEventId

`string`

#### Returns

`Promise`\<[`DomainAutoJoinIntentCreation`](/api/invitation-core/src/type-aliases/domainautojoinintentcreation/)\>

---

### save()

> `abstract` **save**(`policy`): `Promise`\<[`DomainPolicy`](/api/invitation-core/src/type-aliases/domainpolicy/)\>

#### Parameters

##### policy

[`DomainPolicy`](/api/invitation-core/src/type-aliases/domainpolicy/)

#### Returns

`Promise`\<[`DomainPolicy`](/api/invitation-core/src/type-aliases/domainpolicy/)\>
