---
editUrl: false
next: false
prev: false
title: "CreditLedgerServiceOptions"
---

> **CreditLedgerServiceOptions** = `object`

## Properties

### clock?

> `readonly` `optional` **clock?**: () => `Date`

#### Returns

`Date`

---

### eventClaimLeaseMs?

> `readonly` `optional` **eventClaimLeaseMs?**: `number`

---

### eventDelivery?

> `readonly` `optional` **eventDelivery?**: `"development"` \| `"durable"`

---

### eventPublisher?

> `readonly` `optional` **eventPublisher?**: [`CreditLedgerEventPublisher`](/api/credits-core/src/interfaces/creditledgereventpublisher/)

---

### idGenerator?

> `readonly` `optional` **idGenerator?**: () => `string`

#### Returns

`string`

---

### store

> `readonly` **store**: [`CreditLedgerStore`](/api/credits-core/src/classes/creditledgerstore/)
