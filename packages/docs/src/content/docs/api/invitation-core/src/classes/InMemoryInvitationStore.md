---
editUrl: false
next: false
prev: false
title: "InMemoryInvitationStore"
---

테스트와 로컬 개발용 인메모리 초대 저장소입니다.

## Extends

- [`InvitationStore`](/api/invitation-core/src/classes/invitationstore/)

## Constructors

### Constructor

> **new InMemoryInvitationStore**(): `InMemoryInvitationStore`

#### Returns

`InMemoryInvitationStore`

#### Inherited from

[`InvitationStore`](/api/invitation-core/src/classes/invitationstore/).[`constructor`](/api/invitation-core/src/classes/invitationstore/#constructor)

## Methods

### activateEmailInvitation()

> **activateEmailInvitation**(`tenantId`, `idempotencyKey`): `Promise`\<[`EmailInvitationCreation`](/api/invitation-core/src/type-aliases/emailinvitationcreation/) \| `null`\>

#### Parameters

##### tenantId

`string`

##### idempotencyKey

`string`

#### Returns

`Promise`\<[`EmailInvitationCreation`](/api/invitation-core/src/type-aliases/emailinvitationcreation/) \| `null`\>

#### Overrides

[`InvitationStore`](/api/invitation-core/src/classes/invitationstore/).[`activateEmailInvitation`](/api/invitation-core/src/classes/invitationstore/#activateemailinvitation)

---

### claimEmailInvitationEvent()

> **claimEmailInvitationEvent**(`tenantId`, `idempotencyKey`, `claimId`, `claimExpiresAt`): `Promise`\<[`EmailInvitationCreation`](/api/invitation-core/src/type-aliases/emailinvitationcreation/) \| `null`\>

#### Parameters

##### tenantId

`string`

##### idempotencyKey

`string`

##### claimId

`string`

##### claimExpiresAt

`Date`

#### Returns

`Promise`\<[`EmailInvitationCreation`](/api/invitation-core/src/type-aliases/emailinvitationcreation/) \| `null`\>

#### Overrides

[`InvitationStore`](/api/invitation-core/src/classes/invitationstore/).[`claimEmailInvitationEvent`](/api/invitation-core/src/classes/invitationstore/#claimemailinvitationevent)

---

### claimEmailInvitationNotification()

> **claimEmailInvitationNotification**(`tenantId`, `idempotencyKey`, `claimId`, `claimExpiresAt`): `Promise`\<[`EmailInvitationCreation`](/api/invitation-core/src/type-aliases/emailinvitationcreation/) \| `null`\>

#### Parameters

##### tenantId

`string`

##### idempotencyKey

`string`

##### claimId

`string`

##### claimExpiresAt

`Date`

#### Returns

`Promise`\<[`EmailInvitationCreation`](/api/invitation-core/src/type-aliases/emailinvitationcreation/) \| `null`\>

#### Overrides

[`InvitationStore`](/api/invitation-core/src/classes/invitationstore/).[`claimEmailInvitationNotification`](/api/invitation-core/src/classes/invitationstore/#claimemailinvitationnotification)

---

### compareAndSetStatus()

> **compareAndSetStatus**(`tenantId`, `id`, `expected`, `desired`, `meta?`): `Promise`\<[`Invitation`](/api/invitation-core/src/type-aliases/invitation/) \| `null`\>

#### Parameters

##### tenantId

`string`

##### id

`string`

##### expected

[`InvitationStatus`](/api/invitation-core/src/type-aliases/invitationstatus/)

##### desired

[`InvitationStatus`](/api/invitation-core/src/type-aliases/invitationstatus/)

##### meta?

###### acceptedAt?

`Date`

###### rejectedAt?

`Date`

#### Returns

`Promise`\<[`Invitation`](/api/invitation-core/src/type-aliases/invitation/) \| `null`\>

#### Overrides

[`InvitationStore`](/api/invitation-core/src/classes/invitationstore/).[`compareAndSetStatus`](/api/invitation-core/src/classes/invitationstore/#compareandsetstatus)

---

### completeEmailInvitationEvent()

> **completeEmailInvitationEvent**(`tenantId`, `idempotencyKey`, `claimId`): `Promise`\<[`EmailInvitationCreation`](/api/invitation-core/src/type-aliases/emailinvitationcreation/) \| `null`\>

#### Parameters

##### tenantId

`string`

##### idempotencyKey

`string`

##### claimId

`string`

#### Returns

`Promise`\<[`EmailInvitationCreation`](/api/invitation-core/src/type-aliases/emailinvitationcreation/) \| `null`\>

#### Overrides

[`InvitationStore`](/api/invitation-core/src/classes/invitationstore/).[`completeEmailInvitationEvent`](/api/invitation-core/src/classes/invitationstore/#completeemailinvitationevent)

---

### completeEmailInvitationNotification()

> **completeEmailInvitationNotification**(`tenantId`, `idempotencyKey`, `claimId`): `Promise`\<[`EmailInvitationCreation`](/api/invitation-core/src/type-aliases/emailinvitationcreation/) \| `null`\>

#### Parameters

##### tenantId

`string`

##### idempotencyKey

`string`

##### claimId

`string`

#### Returns

`Promise`\<[`EmailInvitationCreation`](/api/invitation-core/src/type-aliases/emailinvitationcreation/) \| `null`\>

#### Overrides

[`InvitationStore`](/api/invitation-core/src/classes/invitationstore/).[`completeEmailInvitationNotification`](/api/invitation-core/src/classes/invitationstore/#completeemailinvitationnotification)

---

### countIssuedByTenant()

> **countIssuedByTenant**(`tenantId`, `since`): `Promise`\<`number`\>

Count all invitations created at or after since for this tenant, regardless of status.

#### Parameters

##### tenantId

`string`

##### since

`Date`

#### Returns

`Promise`\<`number`\>

#### Overrides

[`InvitationStore`](/api/invitation-core/src/classes/invitationstore/).[`countIssuedByTenant`](/api/invitation-core/src/classes/invitationstore/#countissuedbytenant)

---

### countPendingByTenant()

> **countPendingByTenant**(`tenantId`, `since`): `Promise`\<`number`\>

#### Parameters

##### tenantId

`string`

##### since

`Date`

#### Returns

`Promise`\<`number`\>

#### Overrides

[`InvitationStore`](/api/invitation-core/src/classes/invitationstore/).[`countPendingByTenant`](/api/invitation-core/src/classes/invitationstore/#countpendingbytenant)

---

### createEmailInvitation()

> **createEmailInvitation**(`input`): `Promise`\<[`EmailInvitationCreation`](/api/invitation-core/src/type-aliases/emailinvitationcreation/)\>

#### Parameters

##### input

[`EmailInvitationCreation`](/api/invitation-core/src/type-aliases/emailinvitationcreation/)

#### Returns

`Promise`\<[`EmailInvitationCreation`](/api/invitation-core/src/type-aliases/emailinvitationcreation/)\>

#### Overrides

[`InvitationStore`](/api/invitation-core/src/classes/invitationstore/).[`createEmailInvitation`](/api/invitation-core/src/classes/invitationstore/#createemailinvitation)

---

### deleteExpiredEmailInvitationCreations()

> **deleteExpiredEmailInvitationCreations**(`now`): `Promise`\<`number`\>

#### Parameters

##### now

`Date`

#### Returns

`Promise`\<`number`\>

#### Overrides

[`InvitationStore`](/api/invitation-core/src/classes/invitationstore/).[`deleteExpiredEmailInvitationCreations`](/api/invitation-core/src/classes/invitationstore/#deleteexpiredemailinvitationcreations)

---

### findAllByTenant()

> **findAllByTenant**(`tenantId`): `Promise`\<[`Invitation`](/api/invitation-core/src/type-aliases/invitation/)[]\>

#### Parameters

##### tenantId

`string`

#### Returns

`Promise`\<[`Invitation`](/api/invitation-core/src/type-aliases/invitation/)[]\>

#### Overrides

[`InvitationStore`](/api/invitation-core/src/classes/invitationstore/).[`findAllByTenant`](/api/invitation-core/src/classes/invitationstore/#findallbytenant)

---

### findById()

> **findById**(`id`): `Promise`\<[`Invitation`](/api/invitation-core/src/type-aliases/invitation/) \| `null`\>

#### Parameters

##### id

`string`

#### Returns

`Promise`\<[`Invitation`](/api/invitation-core/src/type-aliases/invitation/) \| `null`\>

#### Overrides

[`InvitationStore`](/api/invitation-core/src/classes/invitationstore/).[`findById`](/api/invitation-core/src/classes/invitationstore/#findbyid)

---

### findByTenantAndEmail()

> **findByTenantAndEmail**(`tenantId`, `email`): `Promise`\<[`Invitation`](/api/invitation-core/src/type-aliases/invitation/) \| `null`\>

#### Parameters

##### tenantId

`string`

##### email

`string`

#### Returns

`Promise`\<[`Invitation`](/api/invitation-core/src/type-aliases/invitation/) \| `null`\>

#### Overrides

[`InvitationStore`](/api/invitation-core/src/classes/invitationstore/).[`findByTenantAndEmail`](/api/invitation-core/src/classes/invitationstore/#findbytenantandemail)

---

### findByTokenHash()

> **findByTokenHash**(`tokenHash`): `Promise`\<[`Invitation`](/api/invitation-core/src/type-aliases/invitation/) \| `null`\>

#### Parameters

##### tokenHash

`string`

#### Returns

`Promise`\<[`Invitation`](/api/invitation-core/src/type-aliases/invitation/) \| `null`\>

#### Overrides

[`InvitationStore`](/api/invitation-core/src/classes/invitationstore/).[`findByTokenHash`](/api/invitation-core/src/classes/invitationstore/#findbytokenhash)

---

### findEmailInvitationCreation()

> **findEmailInvitationCreation**(`tenantId`, `idempotencyKey`): `Promise`\<[`EmailInvitationCreation`](/api/invitation-core/src/type-aliases/emailinvitationcreation/) \| `null`\>

#### Parameters

##### tenantId

`string`

##### idempotencyKey

`string`

#### Returns

`Promise`\<[`EmailInvitationCreation`](/api/invitation-core/src/type-aliases/emailinvitationcreation/) \| `null`\>

#### Overrides

[`InvitationStore`](/api/invitation-core/src/classes/invitationstore/).[`findEmailInvitationCreation`](/api/invitation-core/src/classes/invitationstore/#findemailinvitationcreation)

---

### releaseEmailInvitationEvent()

> **releaseEmailInvitationEvent**(`tenantId`, `idempotencyKey`, `claimId`): `Promise`\<`void`\>

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

[`InvitationStore`](/api/invitation-core/src/classes/invitationstore/).[`releaseEmailInvitationEvent`](/api/invitation-core/src/classes/invitationstore/#releaseemailinvitationevent)

---

### releaseEmailInvitationNotification()

> **releaseEmailInvitationNotification**(`tenantId`, `idempotencyKey`, `claimId`): `Promise`\<`void`\>

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

[`InvitationStore`](/api/invitation-core/src/classes/invitationstore/).[`releaseEmailInvitationNotification`](/api/invitation-core/src/classes/invitationstore/#releaseemailinvitationnotification)

---

### save()

> **save**(`invitation`): `Promise`\<[`Invitation`](/api/invitation-core/src/type-aliases/invitation/)\>

#### Parameters

##### invitation

[`Invitation`](/api/invitation-core/src/type-aliases/invitation/)

#### Returns

`Promise`\<[`Invitation`](/api/invitation-core/src/type-aliases/invitation/)\>

#### Overrides

[`InvitationStore`](/api/invitation-core/src/classes/invitationstore/).[`save`](/api/invitation-core/src/classes/invitationstore/#save)

---

### updateStatus()

> **updateStatus**(`tenantId`, `id`, `status`): `Promise`\<[`Invitation`](/api/invitation-core/src/type-aliases/invitation/) \| `null`\>

#### Parameters

##### tenantId

`string`

##### id

`string`

##### status

[`InvitationStatus`](/api/invitation-core/src/type-aliases/invitationstatus/)

#### Returns

`Promise`\<[`Invitation`](/api/invitation-core/src/type-aliases/invitation/) \| `null`\>

#### Overrides

[`InvitationStore`](/api/invitation-core/src/classes/invitationstore/).[`updateStatus`](/api/invitation-core/src/classes/invitationstore/#updatestatus)
