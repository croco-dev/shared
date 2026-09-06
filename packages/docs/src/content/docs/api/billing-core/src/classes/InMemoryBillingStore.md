---
editUrl: false
next: false
prev: false
title: "InMemoryBillingStore"
---

In-memory billing store for testing and development.
NOT suitable for production multi-instance deployments.

## Extends

- [`BillingStore`](/api/billing-core/src/classes/billingstore/)

## Constructors

### Constructor

> **new InMemoryBillingStore**(`clock?`): `InMemoryBillingStore`

#### Parameters

##### clock?

() => `Date`

#### Returns

`InMemoryBillingStore`

#### Overrides

[`BillingStore`](/api/billing-core/src/classes/billingstore/).[`constructor`](/api/billing-core/src/classes/billingstore/#constructor)

## Methods

### claimLifecycleEventDelivery()

> **claimLifecycleEventDelivery**(`command`, `leaseDurationMs`): `Promise`\<[`BillingLifecycleCommand`](/api/billing-core/src/type-aliases/billinglifecyclecommand/) \| `null`\>

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

#### Overrides

[`BillingStore`](/api/billing-core/src/classes/billingstore/).[`claimLifecycleEventDelivery`](/api/billing-core/src/classes/billingstore/#claimlifecycleeventdelivery)

---

### claimWebhookDelivery()

> **claimWebhookDelivery**(`eventId`, `_eventType`, `leaseDurationMs`): `Promise`\<[`BillingWebhookDeliveryClaim`](/api/billing-core/src/type-aliases/billingwebhookdeliveryclaim/)\>

Atomically claims a webhook-addressed delivery with a datastore-time lease.

An active lease returns `in_progress`, an expired lease is reclaimed with a new token and
returns `claimed`, and a completed delivery returns `completed`.

#### Parameters

##### eventId

`string`

##### \_eventType

`string`

##### leaseDurationMs

`number`

#### Returns

`Promise`\<[`BillingWebhookDeliveryClaim`](/api/billing-core/src/type-aliases/billingwebhookdeliveryclaim/)\>

#### Overrides

[`BillingStore`](/api/billing-core/src/classes/billingstore/).[`claimWebhookDelivery`](/api/billing-core/src/classes/billingstore/#claimwebhookdelivery)

---

### commitSubscriptionWebhook()

> **commitSubscriptionWebhook**(`input`): `Promise`\<[`BillingSubscriptionWebhookTransition`](/api/billing-core/src/type-aliases/billingsubscriptionwebhooktransition/)\>

Atomically reserves a subscription webhook, reads its previous subscription, saves the new
subscription, and persists every derived event intent. Repeated calls for the same webhook
must return the original transition without recomputing intents from current subscription
state.

#### Parameters

##### input

[`CommitBillingSubscriptionWebhookInput`](/api/billing-core/src/type-aliases/commitbillingsubscriptionwebhookinput/)

#### Returns

`Promise`\<[`BillingSubscriptionWebhookTransition`](/api/billing-core/src/type-aliases/billingsubscriptionwebhooktransition/)\>

#### Overrides

[`BillingStore`](/api/billing-core/src/classes/billingstore/).[`commitSubscriptionWebhook`](/api/billing-core/src/classes/billingstore/#commitsubscriptionwebhook)

---

### completeWebhook()

> **completeWebhook**(`eventId`): `Promise`\<`void`\>

#### Parameters

##### eventId

`string`

#### Returns

`Promise`\<`void`\>

#### Overrides

[`BillingStore`](/api/billing-core/src/classes/billingstore/).[`completeWebhook`](/api/billing-core/src/classes/billingstore/#completewebhook)

---

### completeWebhookDelivery()

> **completeWebhookDelivery**(`eventId`, `claimToken`): `Promise`\<`boolean`\>

Completes the delivery only for the current, unexpired lease token. Returns `false` for a stale
or expired token.

#### Parameters

##### eventId

`string`

##### claimToken

`string`

#### Returns

`Promise`\<`boolean`\>

#### Overrides

[`BillingStore`](/api/billing-core/src/classes/billingstore/).[`completeWebhookDelivery`](/api/billing-core/src/classes/billingstore/#completewebhookdelivery)

---

### createLifecycleCommand()

> **createLifecycleCommand**(`command`): `Promise`\<[`BillingLifecycleCommand`](/api/billing-core/src/type-aliases/billinglifecyclecommand/)\>

Persists a command before provider I/O.

Implementations must return the existing command when the idempotency key and semantic
command fields match, reject semantic key reuse, and reject a second incomplete command for
the same tenant.

#### Parameters

##### command

[`BillingLifecycleCommand`](/api/billing-core/src/type-aliases/billinglifecyclecommand/)

#### Returns

`Promise`\<[`BillingLifecycleCommand`](/api/billing-core/src/type-aliases/billinglifecyclecommand/)\>

#### Overrides

[`BillingStore`](/api/billing-core/src/classes/billingstore/).[`createLifecycleCommand`](/api/billing-core/src/classes/billingstore/#createlifecyclecommand)

---

### deleteAccount()

> **deleteAccount**(`billingAccountId`): `Promise`\<`void`\>

#### Parameters

##### billingAccountId

`string`

#### Returns

`Promise`\<`void`\>

#### Overrides

[`BillingStore`](/api/billing-core/src/classes/billingstore/).[`deleteAccount`](/api/billing-core/src/classes/billingstore/#deleteaccount)

---

### deleteSubscription()

> **deleteSubscription**(`billingAccountId`): `Promise`\<`void`\>

#### Parameters

##### billingAccountId

`string`

#### Returns

`Promise`\<`void`\>

#### Overrides

[`BillingStore`](/api/billing-core/src/classes/billingstore/).[`deleteSubscription`](/api/billing-core/src/classes/billingstore/#deletesubscription)

---

### failWebhook()

> **failWebhook**(`eventId`): `Promise`\<`void`\>

Idempotently removes a webhook reservation in either reserved or completed state.

This operation must also succeed when no reservation exists so recovery work can be retried
independently of domain-state persistence.

#### Parameters

##### eventId

`string`

#### Returns

`Promise`\<`void`\>

#### Overrides

[`BillingStore`](/api/billing-core/src/classes/billingstore/).[`failWebhook`](/api/billing-core/src/classes/billingstore/#failwebhook)

---

### findAccountByExternalId()

> **findAccountByExternalId**(`externalCustomerId`): `Promise`\<[`BillingAccount`](/api/billing-core/src/type-aliases/billingaccount/) \| `null`\>

#### Parameters

##### externalCustomerId

`string`

#### Returns

`Promise`\<[`BillingAccount`](/api/billing-core/src/type-aliases/billingaccount/) \| `null`\>

#### Overrides

[`BillingStore`](/api/billing-core/src/classes/billingstore/).[`findAccountByExternalId`](/api/billing-core/src/classes/billingstore/#findaccountbyexternalid)

---

### findAccountByTenantId()

> **findAccountByTenantId**(`tenantId`): `Promise`\<[`BillingAccount`](/api/billing-core/src/type-aliases/billingaccount/) \| `null`\>

#### Parameters

##### tenantId

`string`

#### Returns

`Promise`\<[`BillingAccount`](/api/billing-core/src/type-aliases/billingaccount/) \| `null`\>

#### Overrides

[`BillingStore`](/api/billing-core/src/classes/billingstore/).[`findAccountByTenantId`](/api/billing-core/src/classes/billingstore/#findaccountbytenantid)

---

### findLifecycleCommand()

> **findLifecycleCommand**(`idempotencyKey`): `Promise`\<[`BillingLifecycleCommand`](/api/billing-core/src/type-aliases/billinglifecyclecommand/) \| `null`\>

#### Parameters

##### idempotencyKey

`string`

#### Returns

`Promise`\<[`BillingLifecycleCommand`](/api/billing-core/src/type-aliases/billinglifecyclecommand/) \| `null`\>

#### Overrides

[`BillingStore`](/api/billing-core/src/classes/billingstore/).[`findLifecycleCommand`](/api/billing-core/src/classes/billingstore/#findlifecyclecommand)

---

### findOrdersByAccount()

> **findOrdersByAccount**(`billingAccountId`): `Promise`\<[`Order`](/api/billing-core/src/type-aliases/order/)[]\>

#### Parameters

##### billingAccountId

`string`

#### Returns

`Promise`\<[`Order`](/api/billing-core/src/type-aliases/order/)[]\>

#### Overrides

[`BillingStore`](/api/billing-core/src/classes/billingstore/).[`findOrdersByAccount`](/api/billing-core/src/classes/billingstore/#findordersbyaccount)

---

### findPendingLifecycleCommandByTenantId()

> **findPendingLifecycleCommandByTenantId**(`tenantId`): `Promise`\<[`BillingLifecycleCommand`](/api/billing-core/src/type-aliases/billinglifecyclecommand/) \| `null`\>

#### Parameters

##### tenantId

`string`

#### Returns

`Promise`\<[`BillingLifecycleCommand`](/api/billing-core/src/type-aliases/billinglifecyclecommand/) \| `null`\>

#### Overrides

[`BillingStore`](/api/billing-core/src/classes/billingstore/).[`findPendingLifecycleCommandByTenantId`](/api/billing-core/src/classes/billingstore/#findpendinglifecyclecommandbytenantid)

---

### findSubscription()

> **findSubscription**(`billingAccountId`): `Promise`\<[`Subscription`](/api/billing-core/src/type-aliases/subscription/) \| `null`\>

#### Parameters

##### billingAccountId

`string`

#### Returns

`Promise`\<[`Subscription`](/api/billing-core/src/type-aliases/subscription/) \| `null`\>

#### Overrides

[`BillingStore`](/api/billing-core/src/classes/billingstore/).[`findSubscription`](/api/billing-core/src/classes/billingstore/#findsubscription)

---

### findSubscriptionByExternalId()

> **findSubscriptionByExternalId**(`externalSubscriptionId`): `Promise`\<[`Subscription`](/api/billing-core/src/type-aliases/subscription/) \| `null`\>

#### Parameters

##### externalSubscriptionId

`string`

#### Returns

`Promise`\<[`Subscription`](/api/billing-core/src/type-aliases/subscription/) \| `null`\>

#### Overrides

[`BillingStore`](/api/billing-core/src/classes/billingstore/).[`findSubscriptionByExternalId`](/api/billing-core/src/classes/billingstore/#findsubscriptionbyexternalid)

---

### listPendingLifecycleCommands()

> **listPendingLifecycleCommands**(`limit`): `Promise`\<[`BillingLifecycleCommand`](/api/billing-core/src/type-aliases/billinglifecyclecommand/)[]\>

#### Parameters

##### limit

`number`

#### Returns

`Promise`\<[`BillingLifecycleCommand`](/api/billing-core/src/type-aliases/billinglifecyclecommand/)[]\>

#### Overrides

[`BillingStore`](/api/billing-core/src/classes/billingstore/).[`listPendingLifecycleCommands`](/api/billing-core/src/classes/billingstore/#listpendinglifecyclecommands)

---

### markWebhookEventIntentPublished()

> **markWebhookEventIntentPublished**(`eventId`, `intentEventId`): `Promise`\<`void`\>

Marks one stable event intent as durably published. Repeated calls with the same
`intentEventId` must be idempotent.

#### Parameters

##### eventId

`string`

##### intentEventId

`string`

#### Returns

`Promise`\<`void`\>

#### Overrides

[`BillingStore`](/api/billing-core/src/classes/billingstore/).[`markWebhookEventIntentPublished`](/api/billing-core/src/classes/billingstore/#markwebhookeventintentpublished)

---

### reconcileLifecycleSubscription()

> **reconcileLifecycleSubscription**(`command`, `target`): `Promise`\<[`BillingLifecycleLocalResult`](/api/billing-core/src/type-aliases/billinglifecyclelocalresult/)\>

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

#### Overrides

[`BillingStore`](/api/billing-core/src/classes/billingstore/).[`reconcileLifecycleSubscription`](/api/billing-core/src/classes/billingstore/#reconcilelifecyclesubscription)

---

### releaseWebhookDelivery()

> **releaseWebhookDelivery**(`eventId`, `claimToken`): `Promise`\<`boolean`\>

Releases the delivery only for the current, unexpired lease token. Returns `false` for a stale
or expired token.

#### Parameters

##### eventId

`string`

##### claimToken

`string`

#### Returns

`Promise`\<`boolean`\>

#### Overrides

[`BillingStore`](/api/billing-core/src/classes/billingstore/).[`releaseWebhookDelivery`](/api/billing-core/src/classes/billingstore/#releasewebhookdelivery)

---

### reserveWebhook()

> **reserveWebhook**(`eventId`, `_eventType`): `Promise`\<`void`\>

Reserves a provider webhook event for processing.

Store adapters must throw `WebhookAlreadyProcessedProblem` only when the exact event ID
reservation already exists. Other storage failures must retain their original failure semantics.

#### Parameters

##### eventId

`string`

##### \_eventType

`string`

#### Returns

`Promise`\<`void`\>

#### Overrides

[`BillingStore`](/api/billing-core/src/classes/billingstore/).[`reserveWebhook`](/api/billing-core/src/classes/billingstore/#reservewebhook)

---

### reset()

> **reset**(): `void`

Clear all data (for testing)

#### Returns

`void`

---

### resolveLifecycleSubscription()

> **resolveLifecycleSubscription**(`command`): `Promise`\<[`BillingLifecycleSubscriptionResolution`](/api/billing-core/src/type-aliases/billinglifecyclesubscriptionresolution/)\>

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

#### Overrides

[`BillingStore`](/api/billing-core/src/classes/billingstore/).[`resolveLifecycleSubscription`](/api/billing-core/src/classes/billingstore/#resolvelifecyclesubscription)

---

### saveAccount()

> **saveAccount**(`account`): `Promise`\<`void`\>

#### Parameters

##### account

[`BillingAccount`](/api/billing-core/src/type-aliases/billingaccount/)

#### Returns

`Promise`\<`void`\>

#### Overrides

[`BillingStore`](/api/billing-core/src/classes/billingstore/).[`saveAccount`](/api/billing-core/src/classes/billingstore/#saveaccount)

---

### saveLifecycleCommand()

> **saveLifecycleCommand**(`command`): `Promise`\<[`BillingLifecycleCommand`](/api/billing-core/src/type-aliases/billinglifecyclecommand/)\>

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

#### Overrides

[`BillingStore`](/api/billing-core/src/classes/billingstore/).[`saveLifecycleCommand`](/api/billing-core/src/classes/billingstore/#savelifecyclecommand)

---

### saveOrder()

> **saveOrder**(`order`): `Promise`\<`void`\>

#### Parameters

##### order

[`Order`](/api/billing-core/src/type-aliases/order/)

#### Returns

`Promise`\<`void`\>

#### Overrides

[`BillingStore`](/api/billing-core/src/classes/billingstore/).[`saveOrder`](/api/billing-core/src/classes/billingstore/#saveorder)

---

### saveSubscription()

> **saveSubscription**(`subscription`): `Promise`\<`void`\>

#### Parameters

##### subscription

[`Subscription`](/api/billing-core/src/type-aliases/subscription/)

#### Returns

`Promise`\<`void`\>

#### Overrides

[`BillingStore`](/api/billing-core/src/classes/billingstore/).[`saveSubscription`](/api/billing-core/src/classes/billingstore/#savesubscription)
