# SaaS Billing Golden Path Example

This example shows one complete Croco SaaS flow: a customer checks out a paid plan, the service retries a transient payment failure, persists the paid order in a transaction, publishes a domain event after commit, records a backoffice audit projection, and exposes RFC 7807 Problems for recovery paths.

## Architecture Map

| Boundary     | Example role                                          | Files and packages                                                                                         |
| ------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Framework    | DI, logger token, request/runtime context boundaries  | `@croco/framework-context`, `src/app/bootstrap.ts`                                                         |
| Protocol     | REST route metadata and parameter binding             | `@croco/protocols-rest`, `src/protocols/BillingController.ts`                                              |
| Transport    | HTTP route and middleware execution                   | `@croco/transports-http`, `createApp()`                                                                    |
| Host         | Lambda invocation and local Node server lifecycle     | Canonical owners: `@croco/preset-lambda` and `@croco/preset-node`; compatibility methods in `src/index.ts` |
| Build target | Entrypoint, output, format, and bundling metadata     | Deployment configuration outside the runtime app; not selected by `createApp()`                            |
| Domain       | Checkout orchestration, explicit Problems, repository | `src/domain/CheckoutService.ts`, `src/domain/InMemoryOrderRepository.ts`, `src/domain/Problems.ts`         |
| Events       | After-commit domain event and projection              | `@croco/events-core`, `@croco/events-inmemory`, `src/events/OrderPaidEvent.ts`                             |
| Quantity     | Membership seat source and licensed quantity repair   | `@croco/billing-core`, `@croco/membership-core`, `src/integrations/MembershipSeatQuantitySource.ts`        |
| Resilience   | Transient payment retry and terminal decline handling | `@croco/retry-core`, `src/integrations/ScriptedPaymentGateway.ts`                                          |
| Transactions | Save order and publish event only after commit        | `@croco/tx-core`, `src/integrations/InMemoryTxAdapter.ts`                                                  |
| Telemetry    | Checkout span and lifecycle events                    | `@croco/telemetry-api`, `withSpan()`, `recordEvent()`, Lambda `flush` hook in `src/index.ts`               |
| Testing      | Executable HTTP harness and Problem assertions        | `@croco/testing`, `src/tests/golden-path.spec.ts`                                                          |

Primary action: `POST /api/checkouts` creates a paid order.

Success state: the response returns an explicit committed transaction outcome containing the paid order and the
after-commit delivery outcome, `GET /api/orders/:id` reads the order, and `GET /api/backoffice/audit` shows the
after-commit audit entry.

Failure states: invalid checkout input returns `golden-path/checkout-validation`; terminal card decline returns `golden-path/payment-declined` without retrying or persisting an order; missing orders return `golden-path/order-not-found`.

The HTTP bootstrap uses security headers, an explicit CORS origin, a 1 MB body limit, and an in-memory sliding-window rate limiter. These middlewares satisfy Croco's default security validation without external credentials. Disabling security validation is reserved for temporary local migration or test fixtures, not the normal example path.

## Run Locally

From the repository root:

```bash
pnpm --filter @croco-example/saas-billing-golden-path dev
```

Create a checkout that retries once before succeeding:

```bash
curl -X POST http://localhost:3000/api/checkouts \
  -H "Content-Type: application/json" \
  -d '{"customerId":"cus_acme","planId":"growth","seats":3,"paymentToken":"retry_once"}'
```

Read the order:

```bash
curl http://localhost:3000/api/orders/ord_0001
```

Read the backoffice audit projection:

```bash
curl http://localhost:3000/api/backoffice/audit
```

Trigger a terminal payment Problem:

```bash
curl -X POST http://localhost:3000/api/checkouts \
  -H "Content-Type: application/json" \
  -d '{"customerId":"cus_acme","planId":"starter","seats":1,"paymentToken":"card_declined"}'
```

## Validate

The example participates in workspace builds, typechecks, and tests:

```bash
pnpm saas-billing-golden-path:smoke
pnpm --filter @croco-example/saas-billing-golden-path test
pnpm --filter @croco-example/saas-billing-golden-path typecheck
pnpm --filter @croco-example/saas-billing-golden-path build
```

The root smoke command builds the example and its workspace dependencies before running the
checked-in Vitest suite. The suite executes the real HTTP transport with `@croco/testing`, proving
the success path, retry behavior, after-commit event projection, validation Problem, terminal
payment Problem, and not-found Problem.

The membership quantity fixture also proves that membership state commits before a billing reconciliation
intent is created, provider outages leave retryable evidence without rolling membership back, removals reduce
only licensed quantity, stale delivery cannot overwrite newer source state, and a bounded repair scan recovers
missed membership events.

## Deploy

Use `src/index.ts` as the Lambda entry point:

```text
handler = src/index.handler
```

The exported handler awaits the initialized Croco app and passes a Lambda `flush` callback to
`app.lambdaHandler({ flush })`. This method is the checked-in compatibility host convenience on the
HTTP transport. The canonical Lambda host owner is `@croco/preset-lambda` through
`createLambdaHost()`; application-owned composition wraps that retained handler with
`ApplicationRuntime.bindHostCallback()`. In this self-contained example the flush hook is an
in-memory counter. In a deployed service, replace `flushTelemetry` in `src/app/bootstrap.ts` with
`TelemetryRuntime.forceFlush()` from `@croco/telemetry-sdk-node` after initializing the SDK at module
scope.

No cloud credentials are required for local validation. Production adapters can replace `ScriptedPaymentGateway`, `InMemoryOrderRepository`, `InMemoryEventBus`, and `InMemoryTxAdapter` without changing `BillingController` or the checkout recovery contract.
