---
editUrl: false
next: false
prev: false
title: "InvitationStore"
---

초대 저장소 추상 계약입니다.

## Extended by

- [`InMemoryInvitationStore`](/api/invitation-core/src/classes/inmemoryinvitationstore/)
- [`DrizzleInvitationStore`](/api/invitation-drizzle/src/classes/drizzleinvitationstore/)

## Constructors

### Constructor

> **new InvitationStore**(): `InvitationStore`

#### Returns

`InvitationStore`

## Methods

### activateEmailInvitation()

> `abstract` **activateEmailInvitation**(`tenantId`, `idempotencyKey`): `Promise`\<[`EmailInvitationCreation`](/api/invitation-core/src/type-aliases/emailinvitationcreation/) \| `null`\>

#### Parameters

##### tenantId

`string`

##### idempotencyKey

`string`

#### Returns

`Promise`\<[`EmailInvitationCreation`](/api/invitation-core/src/type-aliases/emailinvitationcreation/) \| `null`\>

---

### claimEmailInvitationEvent()

> `abstract` **claimEmailInvitationEvent**(`tenantId`, `idempotencyKey`, `claimId`, `claimExpiresAt`): `Promise`\<[`EmailInvitationCreation`](/api/invitation-core/src/type-aliases/emailinvitationcreation/) \| `null`\>

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

---

### claimEmailInvitationNotification()

> `abstract` **claimEmailInvitationNotification**(`tenantId`, `idempotencyKey`, `claimId`, `claimExpiresAt`): `Promise`\<[`EmailInvitationCreation`](/api/invitation-core/src/type-aliases/emailinvitationcreation/) \| `null`\>

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

---

### compareAndSetStatus()

> `abstract` **compareAndSetStatus**(`tenantId`, `id`, `expected`, `desired`, `meta?`): `Promise`\<[`Invitation`](/api/invitation-core/src/type-aliases/invitation/) \| `null`\>

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

---

### completeEmailInvitationEvent()

> `abstract` **completeEmailInvitationEvent**(`tenantId`, `idempotencyKey`, `claimId`): `Promise`\<[`EmailInvitationCreation`](/api/invitation-core/src/type-aliases/emailinvitationcreation/) \| `null`\>

#### Parameters

##### tenantId

`string`

##### idempotencyKey

`string`

##### claimId

`string`

#### Returns

`Promise`\<[`EmailInvitationCreation`](/api/invitation-core/src/type-aliases/emailinvitationcreation/) \| `null`\>

---

### completeEmailInvitationNotification()

> `abstract` **completeEmailInvitationNotification**(`tenantId`, `idempotencyKey`, `claimId`): `Promise`\<[`EmailInvitationCreation`](/api/invitation-core/src/type-aliases/emailinvitationcreation/) \| `null`\>

#### Parameters

##### tenantId

`string`

##### idempotencyKey

`string`

##### claimId

`string`

#### Returns

`Promise`\<[`EmailInvitationCreation`](/api/invitation-core/src/type-aliases/emailinvitationcreation/) \| `null`\>

---

### countIssuedByTenant()

> `abstract` **countIssuedByTenant**(`tenantId`, `since`): `Promise`\<`number`\>

Count all invitations created at or after since for this tenant, regardless of status.

#### Parameters

##### tenantId

`string`

##### since

`Date`

#### Returns

`Promise`\<`number`\>

---

### countPendingByTenant()

> `abstract` **countPendingByTenant**(`tenantId`, `since`): `Promise`\<`number`\>

#### Parameters

##### tenantId

`string`

##### since

`Date`

#### Returns

`Promise`\<`number`\>

---

### createEmailInvitation()

> `abstract` **createEmailInvitation**(`input`): `Promise`\<[`EmailInvitationCreation`](/api/invitation-core/src/type-aliases/emailinvitationcreation/)\>

#### Parameters

##### input

[`EmailInvitationCreation`](/api/invitation-core/src/type-aliases/emailinvitationcreation/)

#### Returns

`Promise`\<[`EmailInvitationCreation`](/api/invitation-core/src/type-aliases/emailinvitationcreation/)\>

---

### deleteExpiredEmailInvitationCreations()

> `abstract` **deleteExpiredEmailInvitationCreations**(`now`): `Promise`\<`number`\>

#### Parameters

##### now

`Date`

#### Returns

`Promise`\<`number`\>

---

### findAllByTenant()

> `abstract` **findAllByTenant**(`tenantId`): `Promise`\<[`Invitation`](/api/invitation-core/src/type-aliases/invitation/)[]\>

#### Parameters

##### tenantId

`string`

#### Returns

`Promise`\<[`Invitation`](/api/invitation-core/src/type-aliases/invitation/)[]\>

---

### findById()

> `abstract` **findById**(`id`): `Promise`\<[`Invitation`](/api/invitation-core/src/type-aliases/invitation/) \| `null`\>

#### Parameters

##### id

`string`

#### Returns

`Promise`\<[`Invitation`](/api/invitation-core/src/type-aliases/invitation/) \| `null`\>

---

### findByTenantAndEmail()

> `abstract` **findByTenantAndEmail**(`tenantId`, `email`): `Promise`\<[`Invitation`](/api/invitation-core/src/type-aliases/invitation/) \| `null`\>

#### Parameters

##### tenantId

`string`

##### email

`string`

#### Returns

`Promise`\<[`Invitation`](/api/invitation-core/src/type-aliases/invitation/) \| `null`\>

---

### findByTokenHash()

> `abstract` **findByTokenHash**(`tokenHash`): `Promise`\<[`Invitation`](/api/invitation-core/src/type-aliases/invitation/) \| `null`\>

#### Parameters

##### tokenHash

`string`

#### Returns

`Promise`\<[`Invitation`](/api/invitation-core/src/type-aliases/invitation/) \| `null`\>

---

### findEmailInvitationCreation()

> `abstract` **findEmailInvitationCreation**(`tenantId`, `idempotencyKey`): `Promise`\<[`EmailInvitationCreation`](/api/invitation-core/src/type-aliases/emailinvitationcreation/) \| `null`\>

#### Parameters

##### tenantId

`string`

##### idempotencyKey

`string`

#### Returns

`Promise`\<[`EmailInvitationCreation`](/api/invitation-core/src/type-aliases/emailinvitationcreation/) \| `null`\>

---

### releaseEmailInvitationEvent()

> `abstract` **releaseEmailInvitationEvent**(`tenantId`, `idempotencyKey`, `claimId`): `Promise`\<`void`\>

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

### releaseEmailInvitationNotification()

> `abstract` **releaseEmailInvitationNotification**(`tenantId`, `idempotencyKey`, `claimId`): `Promise`\<`void`\>

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

### save()

> `abstract` **save**(`invitation`): `Promise`\<[`Invitation`](/api/invitation-core/src/type-aliases/invitation/)\>

#### Parameters

##### invitation

[`Invitation`](/api/invitation-core/src/type-aliases/invitation/)

#### Returns

`Promise`\<[`Invitation`](/api/invitation-core/src/type-aliases/invitation/)\>

---

### updateStatus()

> `abstract` **updateStatus**(`tenantId`, `id`, `status`): `Promise`\<[`Invitation`](/api/invitation-core/src/type-aliases/invitation/) \| `null`\>

#### Parameters

##### tenantId

`string`

##### id

`string`

##### status

[`InvitationStatus`](/api/invitation-core/src/type-aliases/invitationstatus/)

#### Returns

`Promise`\<[`Invitation`](/api/invitation-core/src/type-aliases/invitation/) \| `null`\>
