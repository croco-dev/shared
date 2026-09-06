---
editUrl: false
next: false
prev: false
title: "CreditLedgerStore"
---

## Extended by

- [`InMemoryCreditLedgerStore`](/api/credits-core/src/classes/inmemorycreditledgerstore/)
- [`DrizzleCreditLedgerStore`](/api/credits-drizzle/src/classes/drizzlecreditledgerstore/)

## Constructors

### Constructor

> **new CreditLedgerStore**(): `CreditLedgerStore`

#### Returns

`CreditLedgerStore`

## Properties

### eventIntentDurability

> `abstract` `readonly` **eventIntentDurability**: `"persistent"` \| `"volatile"`

## Methods

### claimPendingEventIntents()

> `abstract` **claimPendingEventIntents**(`limit?`, `leaseMs?`, `eventId?`): `Promise`\<readonly [`ClaimedCreditLedgerEventIntent`](/api/credits-core/src/type-aliases/claimedcreditledgereventintent/)[]\>

Atomically leases committed, unpublished intents using the store clock.

#### Parameters

##### limit?

`number`

##### leaseMs?

`number`

##### eventId?

`string`

#### Returns

`Promise`\<readonly [`ClaimedCreditLedgerEventIntent`](/api/credits-core/src/type-aliases/claimedcreditledgereventintent/)[]\>

---

### execute()

> `abstract` **execute**(`command`): `Promise`\<[`CreditCommandResult`](/api/credits-core/src/type-aliases/creditcommandresult/)\>

#### Parameters

##### command

[`CreditLedgerCommand`](/api/credits-core/src/type-aliases/creditledgercommand/)

#### Returns

`Promise`\<[`CreditCommandResult`](/api/credits-core/src/type-aliases/creditcommandresult/)\>

---

### getAccount()

> `abstract` **getAccount**(`accountId`): `Promise`\<[`CreditAccount`](/api/credits-core/src/type-aliases/creditaccount/) \| `null`\>

#### Parameters

##### accountId

[`CreditAccountId`](/api/credits-core/src/type-aliases/creditaccountid/)

#### Returns

`Promise`\<[`CreditAccount`](/api/credits-core/src/type-aliases/creditaccount/) \| `null`\>

---

### getBalance()

> `abstract` **getBalance**(`accountId`, `atPosition?`): `Promise`\<[`CreditBalance`](/api/credits-core/src/type-aliases/creditbalance/)\>

#### Parameters

##### accountId

[`CreditAccountId`](/api/credits-core/src/type-aliases/creditaccountid/)

##### atPosition?

`number`

#### Returns

`Promise`\<[`CreditBalance`](/api/credits-core/src/type-aliases/creditbalance/)\>

---

### getHistory()

> `abstract` **getHistory**(`accountId`, `options?`): `Promise`\<[`CreditHistoryPage`](/api/credits-core/src/type-aliases/credithistorypage/)\>

#### Parameters

##### accountId

[`CreditAccountId`](/api/credits-core/src/type-aliases/creditaccountid/)

##### options?

###### afterPosition?

`number`

###### atPosition?

`number`

###### limit?

`number`

#### Returns

`Promise`\<[`CreditHistoryPage`](/api/credits-core/src/type-aliases/credithistorypage/)\>

---

### getPendingEventIntent()

> `abstract` **getPendingEventIntent**(`tenantId`, `idempotencyKey`): `Promise`\<[`CreditLedgerEventIntent`](/api/credits-core/src/type-aliases/creditledgereventintent/) \| `null`\>

#### Parameters

##### tenantId

`string`

##### idempotencyKey

`string`

#### Returns

`Promise`\<[`CreditLedgerEventIntent`](/api/credits-core/src/type-aliases/creditledgereventintent/) \| `null`\>

---

### getReservation()

> `abstract` **getReservation**(`accountId`, `reservationId`): `Promise`\<[`CreditReservation`](/api/credits-core/src/type-aliases/creditreservation/) \| `null`\>

#### Parameters

##### accountId

[`CreditAccountId`](/api/credits-core/src/type-aliases/creditaccountid/)

##### reservationId

[`CreditReservationId`](/api/credits-core/src/type-aliases/creditreservationid/)

#### Returns

`Promise`\<[`CreditReservation`](/api/credits-core/src/type-aliases/creditreservation/) \| `null`\>

---

### listPendingEventIntents()

> `abstract` **listPendingEventIntents**(`limit?`): `Promise`\<readonly [`CreditLedgerEventIntent`](/api/credits-core/src/type-aliases/creditledgereventintent/)[]\>

#### Parameters

##### limit?

`number`

#### Returns

`Promise`\<readonly [`CreditLedgerEventIntent`](/api/credits-core/src/type-aliases/creditledgereventintent/)[]\>

---

### markEventIntentPublished()

> `abstract` **markEventIntentPublished**(`eventId`, `claimToken`): `Promise`\<`boolean`\>

Returns false when the lease expired or another worker owns the intent.

#### Parameters

##### eventId

`string`

##### claimToken

`string`

#### Returns

`Promise`\<`boolean`\>

---

### releaseEventIntentClaim()

> `abstract` **releaseEventIntentClaim**(`eventId`, `claimToken`): `Promise`\<`boolean`\>

#### Parameters

##### eventId

`string`

##### claimToken

`string`

#### Returns

`Promise`\<`boolean`\>
