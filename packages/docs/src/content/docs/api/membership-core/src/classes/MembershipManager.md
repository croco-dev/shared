---
editUrl: false
next: false
prev: false
title: "MembershipManager"
---

멤버십 관리자

## Description

멤버십 라이프사이클을 관리하는 매니저입니다.

- 역할 계층 검증 (owner > admin > member > viewer)
- 소유권 보호 (마지막 소유자 제거/강등 방지)
- 소유권 이전 지원
- 좌석 제한 통합

## Example

**매니저 사용**

```typescript
const manager = new MembershipManager({
  store,
  eventPublisher: idempotentEventPublisher,
  seatLimitChecker,
  eventDelivery: "development",
});

// 멤버 추가
await manager.addMember("tenant-123", "user-456", "member", "member:add:user-456");

// 역할 변경
await manager.updateRole("tenant-123", "user-456", "admin", "member:promote:user-456");

// 소유권 이전
await manager.transferOwnership(
  "tenant-123",
  "current-owner",
  "new-owner",
  "owner:transfer:new-owner",
);

// 멤버 제거
await manager.removeMember("tenant-123", "user-456", "member:remove:user-456");

// 커밋된 intent를 별도 relay 경계에서 발행
await manager.publishPendingEvents();
```

## Implements

- [`AbstractMembershipManager`](/api/membership-core/src/classes/abstractmembershipmanager/)

## Constructors

### Constructor

> **new MembershipManager**(`options`): `MembershipService`

#### Parameters

##### options

[`MembershipServiceOptions`](/api/membership-core/src/type-aliases/membershipserviceoptions/)

#### Returns

`MembershipService`

## Methods

### addMember()

> **addMember**(`tenantId`, `userId`, `role`, `idempotencyKey`): `Promise`\<[`Membership`](/api/membership-core/src/type-aliases/membership/)\>

#### Parameters

##### tenantId

`string`

##### userId

`string`

##### role

[`MembershipRole`](/api/membership-core/src/type-aliases/membershiprole/)

##### idempotencyKey

`string`

#### Returns

`Promise`\<[`Membership`](/api/membership-core/src/type-aliases/membership/)\>

#### Implementation of

[`AbstractMembershipManager`](/api/membership-core/src/classes/abstractmembershipmanager/).[`addMember`](/api/membership-core/src/classes/abstractmembershipmanager/#addmember)

---

### addMemberCommand()

> **addMemberCommand**(`tenantId`, `userId`, `role`, `idempotencyKey`): `Promise`\<\{ `membership`: [`Membership`](/api/membership-core/src/type-aliases/membership/); `operation`: `"add"`; `replayed`: `boolean`; \}\>

#### Parameters

##### tenantId

`string`

##### userId

`string`

##### role

[`MembershipRole`](/api/membership-core/src/type-aliases/membershiprole/)

##### idempotencyKey

`string`

#### Returns

`Promise`\<\{ `membership`: [`Membership`](/api/membership-core/src/type-aliases/membership/); `operation`: `"add"`; `replayed`: `boolean`; \}\>

#### Implementation of

[`AbstractMembershipManager`](/api/membership-core/src/classes/abstractmembershipmanager/).[`addMemberCommand`](/api/membership-core/src/classes/abstractmembershipmanager/#addmembercommand)

---

### getMember()

> **getMember**(`tenantId`, `userId`): `Promise`\<[`Membership`](/api/membership-core/src/type-aliases/membership/)\>

#### Parameters

##### tenantId

`string`

##### userId

`string`

#### Returns

`Promise`\<[`Membership`](/api/membership-core/src/type-aliases/membership/)\>

#### Implementation of

[`AbstractMembershipManager`](/api/membership-core/src/classes/abstractmembershipmanager/).[`getMember`](/api/membership-core/src/classes/abstractmembershipmanager/#getmember)

---

### listMembers()

> **listMembers**(`tenantId`): `Promise`\<[`Membership`](/api/membership-core/src/type-aliases/membership/)[]\>

#### Parameters

##### tenantId

`string`

#### Returns

`Promise`\<[`Membership`](/api/membership-core/src/type-aliases/membership/)[]\>

#### Implementation of

[`AbstractMembershipManager`](/api/membership-core/src/classes/abstractmembershipmanager/).[`listMembers`](/api/membership-core/src/classes/abstractmembershipmanager/#listmembers)

---

### listTenants()

> **listTenants**(`userId`): `Promise`\<[`Membership`](/api/membership-core/src/type-aliases/membership/)[]\>

#### Parameters

##### userId

`string`

#### Returns

`Promise`\<[`Membership`](/api/membership-core/src/type-aliases/membership/)[]\>

#### Implementation of

[`AbstractMembershipManager`](/api/membership-core/src/classes/abstractmembershipmanager/).[`listTenants`](/api/membership-core/src/classes/abstractmembershipmanager/#listtenants)

---

### publishPendingEvents()

> **publishPendingEvents**(`limit?`): `Promise`\<`number`\>

#### Parameters

##### limit?

`number` = `100`

#### Returns

`Promise`\<`number`\>

#### Implementation of

[`AbstractMembershipManager`](/api/membership-core/src/classes/abstractmembershipmanager/).[`publishPendingEvents`](/api/membership-core/src/classes/abstractmembershipmanager/#publishpendingevents)

---

### removeMember()

> **removeMember**(`tenantId`, `userId`, `idempotencyKey`): `Promise`\<`void`\>

#### Parameters

##### tenantId

`string`

##### userId

`string`

##### idempotencyKey

`string`

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`AbstractMembershipManager`](/api/membership-core/src/classes/abstractmembershipmanager/).[`removeMember`](/api/membership-core/src/classes/abstractmembershipmanager/#removemember)

---

### transferOwnership()

> **transferOwnership**(`tenantId`, `fromUserId`, `toUserId`, `idempotencyKey`): `Promise`\<`void`\>

#### Parameters

##### tenantId

`string`

##### fromUserId

`string`

##### toUserId

`string`

##### idempotencyKey

`string`

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`AbstractMembershipManager`](/api/membership-core/src/classes/abstractmembershipmanager/).[`transferOwnership`](/api/membership-core/src/classes/abstractmembershipmanager/#transferownership)

---

### updateRole()

> **updateRole**(`tenantId`, `userId`, `newRole`, `idempotencyKey`): `Promise`\<[`Membership`](/api/membership-core/src/type-aliases/membership/)\>

#### Parameters

##### tenantId

`string`

##### userId

`string`

##### newRole

[`MembershipRole`](/api/membership-core/src/type-aliases/membershiprole/)

##### idempotencyKey

`string`

#### Returns

`Promise`\<[`Membership`](/api/membership-core/src/type-aliases/membership/)\>

#### Implementation of

[`AbstractMembershipManager`](/api/membership-core/src/classes/abstractmembershipmanager/).[`updateRole`](/api/membership-core/src/classes/abstractmembershipmanager/#updaterole)
