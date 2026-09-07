---
editUrl: false
next: false
prev: false
title: "CreditLedgerEventPublisher"
---

## Methods

### onAfterCommit()

> **onAfterCommit**(`publish`): `void`

Registers service-owned publication after commit; must not execute before commit.

#### Parameters

##### publish

() => `Promise`\<`void`\>

#### Returns

`void`

---

### publishIdempotently()

> **publishIdempotently**(`event`): `Promise`\<`void`\>

Must deduplicate retries and concurrent deliveries by `event.eventId`.

#### Parameters

##### event

[`DomainEvent`](/api/events-core/src/classes/domainevent/)

#### Returns

`Promise`\<`void`\>
