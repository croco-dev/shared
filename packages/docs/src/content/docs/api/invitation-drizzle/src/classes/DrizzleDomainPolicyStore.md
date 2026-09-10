---
editUrl: false
next: false
prev: false
title: "DrizzleDomainPolicyStore"
---

도메인 정책 엔터티를 Drizzle로 저장하고 조회하는 구현체입니다.

## Extends

- [`DomainPolicyStore`](/api/invitation-core/src/classes/domainpolicystore/)

## Constructors

### Constructor

> **new DrizzleDomainPolicyStore**(`db`, `txManager`): `DrizzleDomainPolicyStore`

Drizzle 클라이언트와 트랜잭션 매니저를 받아 저장소를 초기화합니다.

#### Parameters

##### db

[`DrizzleDomainPolicyClient`](/api/invitation-drizzle/src/type-aliases/drizzledomainpolicyclient/)

##### txManager

[`TxManager`](/api/tx-core/src/classes/txmanager/)\<[`DrizzleDomainPolicyClient`](/api/invitation-drizzle/src/type-aliases/drizzledomainpolicyclient/)\>

#### Returns

`DrizzleDomainPolicyStore`

#### Overrides

[`DomainPolicyStore`](/api/invitation-core/src/classes/domainpolicystore/).[`constructor`](/api/invitation-core/src/classes/domainpolicystore/#constructor)

## Methods

### claimAutoJoinEvent()

> **claimAutoJoinEvent**(`tenantId`, `idempotencyKey`, `claimId`, `claimExpiresAt`, `expectedEventId`): `Promise`\<[`DomainAutoJoinIntent`](/api/invitation-core/src/type-aliases/domainautojoinintent/) \| `null`\>

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

#### Overrides

[`DomainPolicyStore`](/api/invitation-core/src/classes/domainpolicystore/).[`claimAutoJoinEvent`](/api/invitation-core/src/classes/domainpolicystore/#claimautojoinevent)

---

### completeAutoJoinEvent()

> **completeAutoJoinEvent**(`tenantId`, `idempotencyKey`, `claimId`): `Promise`\<[`DomainAutoJoinIntent`](/api/invitation-core/src/type-aliases/domainautojoinintent/) \| `null`\>

#### Parameters

##### tenantId

`string`

##### idempotencyKey

`string`

##### claimId

`string`

#### Returns

`Promise`\<[`DomainAutoJoinIntent`](/api/invitation-core/src/type-aliases/domainautojoinintent/) \| `null`\>

#### Overrides

[`DomainPolicyStore`](/api/invitation-core/src/classes/domainpolicystore/).[`completeAutoJoinEvent`](/api/invitation-core/src/classes/domainpolicystore/#completeautojoinevent)

---

### completeAutoJoinMembership()

> **completeAutoJoinMembership**(`tenantId`, `idempotencyKey`, `membership`, `expectedEventId`): `Promise`\<[`DomainAutoJoinIntent`](/api/invitation-core/src/type-aliases/domainautojoinintent/) \| `null`\>

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

#### Overrides

[`DomainPolicyStore`](/api/invitation-core/src/classes/domainpolicystore/).[`completeAutoJoinMembership`](/api/invitation-core/src/classes/domainpolicystore/#completeautojoinmembership)

---

### createAutoJoinIntent()

> **createAutoJoinIntent**(`input`): `Promise`\<[`DomainAutoJoinIntentCreation`](/api/invitation-core/src/type-aliases/domainautojoinintentcreation/)\>

#### Parameters

##### input

[`DomainAutoJoinIntent`](/api/invitation-core/src/type-aliases/domainautojoinintent/)

#### Returns

`Promise`\<[`DomainAutoJoinIntentCreation`](/api/invitation-core/src/type-aliases/domainautojoinintentcreation/)\>

#### Overrides

[`DomainPolicyStore`](/api/invitation-core/src/classes/domainpolicystore/).[`createAutoJoinIntent`](/api/invitation-core/src/classes/domainpolicystore/#createautojoinintent)

---

### delete()

> **delete**(`tenantId`, `domain`): `Promise`\<`void`\>

테넌트와 도메인 조합의 정책을 삭제합니다.

#### Parameters

##### tenantId

`string`

##### domain

`string`

#### Returns

`Promise`\<`void`\>

#### Overrides

[`DomainPolicyStore`](/api/invitation-core/src/classes/domainpolicystore/).[`delete`](/api/invitation-core/src/classes/domainpolicystore/#delete)

---

### deleteUncommittedAutoJoinIntent()

> **deleteUncommittedAutoJoinIntent**(`tenantId`, `idempotencyKey`, `expectedEventId`): `Promise`\<`void`\>

#### Parameters

##### tenantId

`string`

##### idempotencyKey

`string`

##### expectedEventId

`string`

#### Returns

`Promise`\<`void`\>

#### Overrides

[`DomainPolicyStore`](/api/invitation-core/src/classes/domainpolicystore/).[`deleteUncommittedAutoJoinIntent`](/api/invitation-core/src/classes/domainpolicystore/#deleteuncommittedautojoinintent)

---

### findAllByTenant()

> **findAllByTenant**(`tenantId`): `Promise`\<[`DomainPolicy`](/api/invitation-core/src/type-aliases/domainpolicy/)[]\>

테넌트의 모든 도메인 정책을 조회합니다.

#### Parameters

##### tenantId

`string`

#### Returns

`Promise`\<[`DomainPolicy`](/api/invitation-core/src/type-aliases/domainpolicy/)[]\>

#### Overrides

[`DomainPolicyStore`](/api/invitation-core/src/classes/domainpolicystore/).[`findAllByTenant`](/api/invitation-core/src/classes/domainpolicystore/#findallbytenant)

---

### findAutoJoinIntent()

> **findAutoJoinIntent**(`tenantId`, `idempotencyKey`): `Promise`\<[`DomainAutoJoinIntent`](/api/invitation-core/src/type-aliases/domainautojoinintent/) \| `null`\>

#### Parameters

##### tenantId

`string`

##### idempotencyKey

`string`

#### Returns

`Promise`\<[`DomainAutoJoinIntent`](/api/invitation-core/src/type-aliases/domainautojoinintent/) \| `null`\>

#### Overrides

[`DomainPolicyStore`](/api/invitation-core/src/classes/domainpolicystore/).[`findAutoJoinIntent`](/api/invitation-core/src/classes/domainpolicystore/#findautojoinintent)

---

### findByTenantAndDomain()

> **findByTenantAndDomain**(`tenantId`, `domain`): `Promise`\<[`DomainPolicy`](/api/invitation-core/src/type-aliases/domainpolicy/) \| `null`\>

테넌트와 도메인 조합으로 정책을 조회합니다.

#### Parameters

##### tenantId

`string`

##### domain

`string`

#### Returns

`Promise`\<[`DomainPolicy`](/api/invitation-core/src/type-aliases/domainpolicy/) \| `null`\>

#### Overrides

[`DomainPolicyStore`](/api/invitation-core/src/classes/domainpolicystore/).[`findByTenantAndDomain`](/api/invitation-core/src/classes/domainpolicystore/#findbytenantanddomain)

---

### releaseAutoJoinEvent()

> **releaseAutoJoinEvent**(`tenantId`, `idempotencyKey`, `claimId`): `Promise`\<`void`\>

#### Parameters

##### tenantId

`string`

##### idempotencyKey

`string`

##### claimId

`string`

#### Returns

`Promise`\<`void`\>

#### Overrides

[`DomainPolicyStore`](/api/invitation-core/src/classes/domainpolicystore/).[`releaseAutoJoinEvent`](/api/invitation-core/src/classes/domainpolicystore/#releaseautojoinevent)

---

### renewAutoJoinIntent()

> **renewAutoJoinIntent**(`input`, `expectedEventId`): `Promise`\<[`DomainAutoJoinIntentCreation`](/api/invitation-core/src/type-aliases/domainautojoinintentcreation/)\>

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

#### Overrides

[`DomainPolicyStore`](/api/invitation-core/src/classes/domainpolicystore/).[`renewAutoJoinIntent`](/api/invitation-core/src/classes/domainpolicystore/#renewautojoinintent)

---

### save()

> **save**(`policy`): `Promise`\<[`DomainPolicy`](/api/invitation-core/src/type-aliases/domainpolicy/)\>

도메인 정책을 upsert 방식으로 저장합니다.

#### Parameters

##### policy

[`DomainPolicy`](/api/invitation-core/src/type-aliases/domainpolicy/)

#### Returns

`Promise`\<[`DomainPolicy`](/api/invitation-core/src/type-aliases/domainpolicy/)\>

#### Overrides

[`DomainPolicyStore`](/api/invitation-core/src/classes/domainpolicystore/).[`save`](/api/invitation-core/src/classes/domainpolicystore/#save)
