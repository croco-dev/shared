import {
  BillingCheckoutInProgressProblem,
  hashCheckoutValue,
  stableStringify,
  type BillingGateway,
  type BillingLifecycleGatewayOptions,
  type CheckoutResult,
  type CreateCheckoutParams,
} from "@croco/billing-core";
import type { ILogger } from "@croco/framework-context";
import { Component, Inject, LOGGER_TOKEN } from "@croco/framework-context";
import { Polar } from "@polar-sh/sdk";
import type { PolarConfig } from "../types";
import {
  normalizePolarBillingError,
  PolarCheckoutIdempotencyConflictProblem,
  PolarRetryableUpstreamProblem,
  PolarSubscriptionNotFoundProblem,
  validatePolarConfig,
} from "./problems/PolarBillingProblems";

const POLAR_RETRY_CONFIG = {
  strategy: "backoff" as const,
  retryConnectionErrors: true,
  backoff: {
    initialInterval: 500,
    maxInterval: 5_000,
    exponent: 1.5,
    maxElapsedTime: 15_000,
  },
};

const POLAR_RETRY_CODES = ["429", "500", "502", "503", "504"];
const CHECKOUT_OPERATION_KEY_METADATA = "croco_checkout_operation";
const CHECKOUT_FINGERPRINT_METADATA = "croco_checkout_fingerprint";
const CHECKOUT_RECONCILIATION_ATTEMPTS = 3;
const CHECKOUT_RECONCILIATION_DELAY_MS = 25;
const DEFAULT_CHECKOUT_RECOVERY_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_CHECKOUT_RECOVERY_CAPACITY = 1_000;

type AmbiguousCheckoutOperation = {
  readonly insertedAt: number;
  lastAttemptAt: number;
};

type PolarLookupError = Error & {
  error?: string;
};

@Component()
export class PolarBillingGateway implements BillingGateway {
  private readonly client: Polar;
  private readonly organizationId?: string;
  private readonly checkoutRecoveryTtlMs: number;
  private readonly checkoutRecoveryCapacity: number;
  private readonly ambiguousCheckoutOperations = new Map<string, AmbiguousCheckoutOperation>();

  constructor(
    config: PolarConfig,
    @Inject(LOGGER_TOKEN) private readonly logger: ILogger,
  ) {
    const validConfig = validatePolarConfig(config);

    this.client = new Polar({
      accessToken: validConfig.accessToken,
      server: validConfig.environment,
    });
    this.organizationId = validConfig.organizationId;
    this.checkoutRecoveryTtlMs =
      validConfig.checkoutRecovery?.ttlMs ?? DEFAULT_CHECKOUT_RECOVERY_TTL_MS;
    this.checkoutRecoveryCapacity =
      validConfig.checkoutRecovery?.capacity ?? DEFAULT_CHECKOUT_RECOVERY_CAPACITY;
  }

  async ensureCustomer(billingAccountId: string, email: string): Promise<string> {
    try {
      const existing = await this.client.customers.getExternal(
        {
          externalId: billingAccountId,
        },
        {
          retries: POLAR_RETRY_CONFIG,
          retryCodes: POLAR_RETRY_CODES,
        },
      );

      if (existing) {
        return existing.id;
      }
    } catch (error) {
      if (!this.isCustomerNotFoundError(error)) {
        throw normalizePolarBillingError(error, "ensureCustomer.lookup");
      }

      this.logger.info("Customer not found, creating new customer", {
        billingAccountId,
      });
    }

    let created: { id: string };
    try {
      created = await this.client.customers.create({
        externalId: billingAccountId,
        email,
        organizationId: this.organizationId,
      });
    } catch (error) {
      throw normalizePolarBillingError(error, "ensureCustomer.create");
    }

    return created.id;
  }

  private isCustomerNotFoundError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const polarError = error as PolarLookupError;

    return polarError.name === "ResourceNotFound" || polarError.error === "ResourceNotFound";
  }

  async createCheckout(params: CreateCheckoutParams): Promise<CheckoutResult> {
    const customerId = await this.ensureCustomer(params.billingAccountId, params.email);
    const operationKey = hashCheckoutValue(params.idempotencyKey);
    const fingerprint = checkoutFingerprint(params);
    const now = Date.now();

    this.purgeExpiredAmbiguousCheckoutOperations(now);

    const ambiguousOperation = this.ambiguousCheckoutOperations.get(operationKey);
    if (ambiguousOperation) {
      ambiguousOperation.lastAttemptAt = now;
      const reconciled = await this.reconcileCheckoutForCustomer(
        customerId,
        operationKey,
        fingerprint,
      );
      if (reconciled) {
        this.ambiguousCheckoutOperations.delete(operationKey);
        return reconciled;
      }
      throw new BillingCheckoutInProgressProblem(params.billingAccountId);
    }

    const existing = await this.findCheckoutByOperation(customerId, operationKey, fingerprint);

    if (existing) {
      return existing;
    }

    let checkout: { id: string; url: string };
    try {
      checkout = await this.client.checkouts.create({
        products: [params.productId],
        customerId,
        successUrl: params.successUrl,
        ...(params.cancelUrl && { cancelUrl: params.cancelUrl }),
        metadata: {
          [CHECKOUT_OPERATION_KEY_METADATA]: operationKey,
          [CHECKOUT_FINGERPRINT_METADATA]: fingerprint,
        },
      });
    } catch (error) {
      const reconciled = await this.reconcileCheckoutForCustomer(
        customerId,
        operationKey,
        fingerprint,
      );
      if (reconciled) {
        return reconciled;
      }

      const normalized = normalizePolarBillingError(error, "createCheckout");
      if (normalized instanceof PolarRetryableUpstreamProblem) {
        this.trackAmbiguousCheckoutOperation(operationKey, Date.now());
        throw new BillingCheckoutInProgressProblem(params.billingAccountId);
      }
      throw normalized;
    }

    return {
      checkoutUrl: checkout.url,
      checkoutId: checkout.id,
    };
  }

  async reconcileCheckout(params: CreateCheckoutParams): Promise<CheckoutResult | null> {
    const customerId = await this.ensureCustomer(params.billingAccountId, params.email);
    const operationKey = hashCheckoutValue(params.idempotencyKey);
    const checkout = await this.reconcileCheckoutForCustomer(
      customerId,
      operationKey,
      checkoutFingerprint(params),
    );

    if (checkout) {
      this.ambiguousCheckoutOperations.delete(operationKey);
    }

    return checkout;
  }

  private async reconcileCheckoutForCustomer(
    customerId: string,
    operationKey: string,
    fingerprint: string,
  ): Promise<CheckoutResult | null> {
    for (let attempt = 1; attempt <= CHECKOUT_RECONCILIATION_ATTEMPTS; attempt += 1) {
      const checkout = await this.findCheckoutByOperation(customerId, operationKey, fingerprint);
      if (checkout) {
        return checkout;
      }

      if (attempt < CHECKOUT_RECONCILIATION_ATTEMPTS) {
        await delay(CHECKOUT_RECONCILIATION_DELAY_MS * attempt);
      }
    }

    return null;
  }

  private trackAmbiguousCheckoutOperation(operationKey: string, now: number): void {
    this.purgeExpiredAmbiguousCheckoutOperations(now);

    const existing = this.ambiguousCheckoutOperations.get(operationKey);
    if (existing) {
      existing.lastAttemptAt = now;
      return;
    }

    if (this.ambiguousCheckoutOperations.size >= this.checkoutRecoveryCapacity) {
      const eviction = this.findLeastRecentlyAttemptedOperation();
      if (eviction) {
        const [evictedOperationKey, evictedOperation] = eviction;
        this.ambiguousCheckoutOperations.delete(evictedOperationKey);
        this.logger.warn(
          "Ambiguous checkout reconciliation tracking evicted without completion evidence",
          {
            event: "billing-polar.ambiguous-checkout.evicted",
            reason: "capacity",
            operationKey: evictedOperationKey,
            insertedAt: evictedOperation.insertedAt,
            lastAttemptAt: evictedOperation.lastAttemptAt,
            capacity: this.checkoutRecoveryCapacity,
          },
        );
      }
    }

    this.ambiguousCheckoutOperations.set(operationKey, {
      insertedAt: now,
      lastAttemptAt: now,
    });
  }

  private purgeExpiredAmbiguousCheckoutOperations(now: number): void {
    for (const [operationKey, operation] of this.ambiguousCheckoutOperations) {
      if (now - operation.insertedAt < this.checkoutRecoveryTtlMs) {
        continue;
      }

      this.ambiguousCheckoutOperations.delete(operationKey);
      this.logger.warn(
        "Ambiguous checkout reconciliation tracking expired without completion evidence",
        {
          event: "billing-polar.ambiguous-checkout.expired",
          reason: "expired",
          operationKey,
          insertedAt: operation.insertedAt,
          lastAttemptAt: operation.lastAttemptAt,
          ttlMs: this.checkoutRecoveryTtlMs,
        },
      );
    }
  }

  private findLeastRecentlyAttemptedOperation():
    | readonly [string, AmbiguousCheckoutOperation]
    | undefined {
    let oldest: readonly [string, AmbiguousCheckoutOperation] | undefined;

    for (const entry of this.ambiguousCheckoutOperations) {
      if (!oldest || compareAmbiguousCheckoutOperations(entry, oldest) < 0) {
        oldest = entry;
      }
    }

    return oldest;
  }

  private async findCheckoutByOperation(
    customerId: string,
    operationKey: string,
    fingerprint: string,
  ): Promise<CheckoutResult | null> {
    let pages;
    try {
      pages = await this.client.checkouts.list(
        {
          customerId,
          limit: 100,
        },
        {
          retries: POLAR_RETRY_CONFIG,
          retryCodes: POLAR_RETRY_CODES,
        },
      );
    } catch (error) {
      throw normalizePolarBillingError(error, "createCheckout.reconcile");
    }

    try {
      for await (const page of pages) {
        for (const checkout of page.result.items) {
          if (checkout.metadata[CHECKOUT_OPERATION_KEY_METADATA] !== operationKey) {
            continue;
          }

          if (checkout.metadata[CHECKOUT_FINGERPRINT_METADATA] !== fingerprint) {
            throw new PolarCheckoutIdempotencyConflictProblem(
              "createCheckout.reconcile",
              operationKey,
            );
          }

          return {
            checkoutId: checkout.id,
            checkoutUrl: checkout.url,
          };
        }
      }
    } catch (error) {
      throw normalizePolarBillingError(error, "createCheckout.reconcile");
    }

    return null;
  }

  async cancelSubscription(
    externalSubscriptionId: string,
    immediate: boolean,
    options: BillingLifecycleGatewayOptions,
  ): Promise<void> {
    const requestOptions = {
      headers: {
        "Idempotency-Key": options.idempotencyKey,
      },
    };
    try {
      if (immediate) {
        await this.client.subscriptions.revoke(
          {
            id: externalSubscriptionId,
          },
          requestOptions,
        );
      } else {
        await this.client.subscriptions.update(
          {
            id: externalSubscriptionId,
            subscriptionUpdate: {
              cancelAtPeriodEnd: true,
            },
          },
          requestOptions,
        );
      }
    } catch (error) {
      if (
        this.isAlreadyCanceledSubscriptionError(error) &&
        (await this.isCancellationTargetApplied(externalSubscriptionId, immediate))
      ) {
        return;
      }
      throw normalizePolarBillingError(error, "cancelSubscription");
    }
  }

  async resumeSubscription(
    externalSubscriptionId: string,
    options: BillingLifecycleGatewayOptions,
  ): Promise<void> {
    try {
      await this.client.subscriptions.update(
        {
          id: externalSubscriptionId,
          subscriptionUpdate: {
            cancelAtPeriodEnd: false,
          },
        },
        {
          headers: {
            "Idempotency-Key": options.idempotencyKey,
          },
        },
      );
    } catch (error) {
      throw normalizePolarBillingError(error, "resumeSubscription");
    }
  }

  async getCustomerPortalUrl(externalCustomerId: string): Promise<string> {
    let session: { customerPortalUrl: string };
    try {
      session = await this.client.customerSessions.create({
        customerId: externalCustomerId,
      });
    } catch (error) {
      throw normalizePolarBillingError(error, "getCustomerPortalUrl");
    }

    return session.customerPortalUrl;
  }

  private isAlreadyCanceledSubscriptionError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const record = error as Error & { error?: unknown };
    return (
      record.name === "AlreadyCanceledSubscription" ||
      record.error === "AlreadyCanceledSubscription"
    );
  }

  private async isCancellationTargetApplied(
    externalSubscriptionId: string,
    immediate: boolean,
  ): Promise<boolean> {
    try {
      const subscription = await this.client.subscriptions.get({
        id: externalSubscriptionId,
      });
      if (immediate) {
        return subscription.status === "canceled" || subscription.status === "revoked";
      }

      return subscription.cancelAtPeriodEnd;
    } catch (error) {
      const normalized = normalizePolarBillingError(error, "cancelSubscription.reconcile");
      if (normalized instanceof PolarSubscriptionNotFoundProblem) {
        return false;
      }

      throw normalized;
    }
  }
}

function checkoutFingerprint(params: CreateCheckoutParams): string {
  return hashCheckoutValue(
    stableStringify({
      billingAccountId: params.billingAccountId,
      cancelUrl: params.cancelUrl ?? null,
      email: params.email,
      productId: params.productId,
      successUrl: params.successUrl,
    }),
  );
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function compareAmbiguousCheckoutOperations(
  [operationKey, operation]: readonly [string, AmbiguousCheckoutOperation],
  [currentOperationKey, currentOperation]: readonly [string, AmbiguousCheckoutOperation],
): number {
  return (
    operation.lastAttemptAt - currentOperation.lastAttemptAt ||
    operation.insertedAt - currentOperation.insertedAt ||
    operationKey.localeCompare(currentOperationKey)
  );
}
