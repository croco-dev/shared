---
editUrl: false
next: false
prev: false
title: "BillingStore"
---

Abstract storage for billing data.
The framework provides `InMemoryBillingStore`; applications may supply persistent adapters.

## Extended by

- [`InMemoryBillingStore`](/api/billing-core/src/classes/inmemorybillingstore/)

## Constructors

### Constructor

> **new BillingStore**(): `BillingStore`

#### Returns

`BillingStore`

## Methods

### claimLifecycleEventDelivery()

> `abstract` **claimLifecycleEventDelivery**(`command`, `leaseDurationMs`): `Promise`\<[`BillingLifecycleCommand`](/api/billing-core/src/type-aliases/billinglifecyclecommand/) \| `null`\>

Atomically claims event delivery for the expected command revision.

Implementations must return `null` when the command is no longer `pending_event`, the revision
is stale, or another unexpired delivery lease exists. A successful claim increments the
revision and persists a lease computed from datastore-authoritative time.

#### Parameters

##### command

[`BillingLifecycleCommand`](/api/billing-core/src/type-aliases/billinglifecyclecommand/)

##### leaseDurationMs

`number`

#### Returns

`Promise`\<[`BillingLifecycleCommand`](/api/billing-core/src/type-aliases/billinglifecyclecommand/) \| `null`\>

---

### claimWebhookDelivery()

> `abstract` **claimWebhookDelivery**(`eventId`, `eventType`, `leaseDurationMs`): `Promise`\<[`BillingWebhookDeliveryClaim`](/api/billing-core/src/type-aliases/billingwebhookdeliveryclaim/)\>

Atomically claims a webhook-addressed delivery with a datastore-time lease.

An active lease returns `in_progress`, an expired lease is reclaimed with a new token and
returns `claimed`, and a completed delivery returns `completed`.

#### Parameters

##### eventId

`string`

##### eventType

`string`

##### leaseDurationMs

`number`

#### Returns

`Promise`\<[`BillingWebhookDeliveryClaim`](/api/billing-core/src/type-aliases/billingwebhookdeliveryclaim/)\>

---

### commitSubscriptionWebhook()

> `abstract` **commitSubscriptionWebhook**(`input`): `Promise`\<[`BillingSubscriptionWebhookTransition`](/api/billing-core/src/type-aliases/billingsubscriptionwebhooktransition/)\>

Atomically reserves a subscription webhook, reads its previous subscription, saves the new
subscription, and persists every derived event intent. Repeated calls for the same webhook
must return the original transition without recomputing intents from current subscription
state.

#### Parameters

##### input

[`CommitBillingSubscriptionWebhookInput`](/api/billing-core/src/type-aliases/commitbillingsubscriptionwebhookinput/)

#### Returns

`Promise`\<[`BillingSubscriptionWebhookTransition`](/api/billing-core/src/type-aliases/billingsubscriptionwebhooktransition/)\>

---

### completeWebhook()

> `abstract` **completeWebhook**(`eventId`): `Promise`\<`void`\>

#### Parameters

##### eventId

`string`

#### Returns

`Promise`\<`void`\>

---

### completeWebhookDelivery()

> `abstract` **completeWebhookDelivery**(`eventId`, `claimToken`): `Promise`\<`boolean`\>

Completes the delivery only for the current, unexpired lease token. Returns `false` for a stale
or expired token.

#### Parameters

##### eventId

`string`

##### claimToken

`string`

#### Returns

`Promise`\<`boolean`\>

---

### createLifecycleCommand()

> `abstract` **createLifecycleCommand**(`command`): `Promise`\<[`BillingLifecycleCommand`](/api/billing-core/src/type-aliases/billinglifecyclecommand/)\>

Persists a command before provider I/O.

Implementations must return the existing command when the idempotency key and semantic
command fields match, reject semantic key reuse, and reject a second incomplete command for
the same tenant.

#### Parameters

##### command

[`BillingLifecycleCommand`](/api/billing-core/src/type-aliases/billinglifecyclecommand/)

#### Returns

`Promise`\<[`BillingLifecycleCommand`](/api/billing-core/src/type-aliases/billinglifecyclecommand/)\>

---

### deleteAccount()

> `abstract` **deleteAccount**(`billingAccountId`): `Promise`\<`void`\>

#### Parameters

##### billingAccountId

`string`

#### Returns

`Promise`\<`void`\>

---

### deleteSubscription()

> `abstract` **deleteSubscription**(`billingAccountId`): `Promise`\<`void`\>

#### Parameters

##### billingAccountId

`string`

#### Returns

`Promise`\<`void`\>

---

### failWebhook()

> `abstract` **failWebhook**(`eventId`): `Promise`\<`void`\>

Idempotently removes a webhook reservation in either reserved or completed state.

This operation must also succeed when no reservation exists so recovery work can be retried
independently of domain-state persistence.

#### Parameters

##### eventId

`string`

#### Returns

`Promise`\<`void`\>

---

### findAccountByExternalId()

> `abstract` **findAccountByExternalId**(`externalCustomerId`): `Promise`\<[`BillingAccount`](/api/billing-core/src/type-aliases/billingaccount/) \| `null`\>

#### Parameters

##### externalCustomerId

`string`

#### Returns

`Promise`\<[`BillingAccount`](/api/billing-core/src/type-aliases/billingaccount/) \| `null`\>

---

### findAccountByTenantId()

> `abstract` **findAccountByTenantId**(`tenantId`): `Promise`\<[`BillingAccount`](/api/billing-core/src/type-aliases/billingaccount/) \| `null`\>

#### Parameters

##### tenantId

`string`

#### Returns

`Promise`\<[`BillingAccount`](/api/billing-core/src/type-aliases/billingaccount/) \| `null`\>

---

### findLifecycleCommand()

> `abstract` **findLifecycleCommand**(`idempotencyKey`): `Promise`\<[`BillingLifecycleCommand`](/api/billing-core/src/type-aliases/billinglifecyclecommand/) \| `null`\>

#### Parameters

##### idempotencyKey

`string`

#### Returns

`Promise`\<[`BillingLifecycleCommand`](/api/billing-core/src/type-aliases/billinglifecyclecommand/) \| `null`\>

---

### findOrdersByAccount()

> `abstract` **findOrdersByAccount**(`billingAccountId`): `Promise`\<[`Order`](/api/billing-core/src/type-aliases/order/)[]\>

#### Parameters

##### billingAccountId

`string`

#### Returns

`Promise`\<[`Order`](/api/billing-core/src/type-aliases/order/)[]\>

---

### findPendingLifecycleCommandByTenantId()

> `abstract` **findPendingLifecycleCommandByTenantId**(`tenantId`): `Promise`\<[`BillingLifecycleCommand`](/api/billing-core/src/type-aliases/billinglifecyclecommand/) \| `null`\>

#### Parameters

##### tenantId

`string`

#### Returns

`Promise`\<[`BillingLifecycleCommand`](/api/billing-core/src/type-aliases/billinglifecyclecommand/) \| `null`\>

---

### findSubscription()

> `abstract` **findSubscription**(`billingAccountId`): `Promise`\<[`Subscription`](/api/billing-core/src/type-aliases/subscription/) \| `null`\>

#### Parameters

##### billingAccountId

`string`

#### Returns

`Promise`\<[`Subscription`](/api/billing-core/src/type-aliases/subscription/) \| `null`\>

---

### findSubscriptionByExternalId()

> `abstract` **findSubscriptionByExternalId**(`externalSubscriptionId`): `Promise`\<[`Subscription`](/api/billing-core/src/type-aliases/subscription/) \| `null`\>

#### Parameters

##### externalSubscriptionId

`string`

#### Returns

`Promise`\<[`Subscription`](/api/billing-core/src/type-aliases/subscription/) \| `null`\>

---

### listPendingLifecycleCommands()

> `abstract` **listPendingLifecycleCommands**(`limit`): `Promise`\<[`BillingLifecycleCommand`](/api/billing-core/src/type-aliases/billinglifecyclecommand/)[]\>

#### Parameters

##### limit

`number`

#### Returns

`Promise`\<[`BillingLifecycleCommand`](/api/billing-core/src/type-aliases/billinglifecyclecommand/)[]\>

---

### markWebhookEventIntentPublished()

> `abstract` **markWebhookEventIntentPublished**(`eventId`, `intentEventId`): `Promise`\<`void`\>

Marks one stable event intent as durably published. Repeated calls with the same
`intentEventId` must be idempotent.

#### Parameters

##### eventId

`string`

##### intentEventId

`string`

#### Returns

`Promise`\<`void`\>

---

### reconcileLifecycleSubscription()

> `abstract` **reconcileLifecycleSubscription**(`command`, `target`): `Promise`\<[`BillingLifecycleLocalResult`](/api/billing-core/src/type-aliases/billinglifecyclelocalresult/)\>

Applies a lifecycle target while the stored external subscription identity still matches the
command. Implementations must atomically rebase the lifecycle delta onto a newer snapshot of
that same external subscription. A `null` target atomically removes only the matching
subscription. The billing account and its lookup indices must be preserved.

Implementations must return `superseded` without mutation only when a different external
subscription occupies the billing account.

#### Parameters

##### command

[`BillingLifecycleCommand`](/api/billing-core/src/type-aliases/billinglifecyclecommand/)

##### target

[`Subscription`](/api/billing-core/src/type-aliases/subscription/) \| `null`

#### Returns

`Promise`\<[`BillingLifecycleLocalResult`](/api/billing-core/src/type-aliases/billinglifecyclelocalresult/)\>

---

### releaseWebhookDelivery()

> `abstract` **releaseWebhookDelivery**(`eventId`, `claimToken`): `Promise`\<`boolean`\>

Releases the delivery only for the current, unexpired lease token. Returns `false` for a stale
or expired token.

#### Parameters

##### eventId

`string`

##### claimToken

`string`

#### Returns

`Promise`\<`boolean`\>

---

### reserveWebhook()

> `abstract` **reserveWebhook**(`eventId`, `eventType`): `Promise`\<`void`\>

Reserves a provider webhook event for processing.

Store adapters must throw `WebhookAlreadyProcessedProblem` only when the exact event ID
reservation already exists. Other storage failures must retain their original failure semantics.

#### Parameters

##### eventId

`string`

##### eventType

`string`

#### Returns

`Promise`\<`void`\>

---

### resolveLifecycleSubscription()

> `abstract` **resolveLifecycleSubscription**(`command`): `Promise`\<[`BillingLifecycleSubscriptionResolution`](/api/billing-core/src/type-aliases/billinglifecyclesubscriptionresolution/)\>

Atomically resolves the subscription state for a pending lifecycle projection.

Implementations must verify the command revision and pending state in the same operation that
reads and classifies the subscription. The result must carry either the latest same-identity
projection base or the authoritative replacement/absent state so callers never perform a
second, racy subscription read.

#### Parameters

##### command

[`BillingLifecycleCommand`](/api/billing-core/src/type-aliases/billinglifecyclecommand/)

#### Returns

`Promise`\<[`BillingLifecycleSubscriptionResolution`](/api/billing-core/src/type-aliases/billinglifecyclesubscriptionresolution/)\>

---

### saveAccount()

> `abstract` **saveAccount**(`account`): `Promise`\<`void`\>

#### Parameters

##### account

[`BillingAccount`](/api/billing-core/src/type-aliases/billingaccount/)

#### Returns

`Promise`\<`void`\>

---

### saveLifecycleCommand()

> `abstract` **saveLifecycleCommand**(`command`): `Promise`\<[`BillingLifecycleCommand`](/api/billing-core/src/type-aliases/billinglifecyclecommand/)\>

Saves failure evidence or advances a command monotonically through
`pending_provider` -> `pending_local` -> optional `pending_event` -> `completed`.

`command.revision` is the expected current revision. Implementations must compare and increment
it atomically, reject stale writes, semantic mutations, invalid transitions, and attempts to
reopen or rewrite a completed command. Once local reconciliation runs, the command's
`localResult` must be persisted as durable convergence evidence.

#### Parameters

##### command

[`BillingLifecycleCommand`](/api/billing-core/src/type-aliases/billinglifecyclecommand/)

#### Returns

`Promise`\<[`BillingLifecycleCommand`](/api/billing-core/src/type-aliases/billinglifecyclecommand/)\>

---

### saveOrder()

> `abstract` **saveOrder**(`order`): `Promise`\<`void`\>

#### Parameters

##### order

[`Order`](/api/billing-core/src/type-aliases/order/)

#### Returns

`Promise`\<`void`\>

---

### saveSubscription()

> `abstract` **saveSubscription**(`subscription`): `Promise`\<`void`\>

#### Parameters

##### subscription

[`Subscription`](/api/billing-core/src/type-aliases/subscription/)

#### Returns

`Promise`\<`void`\>
