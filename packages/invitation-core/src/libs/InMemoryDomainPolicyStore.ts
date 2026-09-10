import { DomainAutoJoinRecoveryProblem } from "./problems/DomainPolicyProblems";
import { DomainPolicyStore } from "./DomainPolicyStore";
import type { Membership } from "@croco/membership-core";
import type {
  DomainAutoJoinIntent,
  DomainAutoJoinIntentCreation,
  DomainAutoJoinIntentInput,
  DomainPolicy,
} from "./types";

export class InMemoryDomainPolicyStore extends DomainPolicyStore {
  private readonly storage = new Map<string, DomainPolicy>();
  private readonly autoJoinIntents = new Map<string, DomainAutoJoinIntent>();

  async findByTenantAndDomain(tenantId: string, domain: string): Promise<DomainPolicy | null> {
    return this.storage.get(this.getKey(tenantId, domain)) ?? null;
  }

  async findAllByTenant(tenantId: string): Promise<DomainPolicy[]> {
    return [...this.storage.values()].filter((policy) => policy.tenantId === tenantId);
  }

  async save(policy: DomainPolicy): Promise<DomainPolicy> {
    const key = this.getKey(policy.tenantId, policy.domain);
    this.storage.set(key, policy);
    return policy;
  }

  async delete(tenantId: string, domain: string): Promise<void> {
    const key = this.getKey(tenantId, domain);
    this.storage.delete(key);
  }

  async createAutoJoinIntent(
    input: DomainAutoJoinIntentInput,
  ): Promise<DomainAutoJoinIntentCreation> {
    const scope = this.getAutoJoinScope(input.tenantId, input.idempotencyKey);
    const existing = this.autoJoinIntents.get(scope);
    if (existing) {
      return { intent: structuredClone(existing), created: false };
    }

    const intent = structuredClone(input);
    this.autoJoinIntents.set(scope, intent);
    return { intent: structuredClone(intent), created: true };
  }

  async renewAutoJoinIntent(
    input: DomainAutoJoinIntentInput,
    expectedEventId: string,
  ): Promise<DomainAutoJoinIntentCreation> {
    const scope = this.getAutoJoinScope(input.tenantId, input.idempotencyKey);
    const existing = this.autoJoinIntents.get(scope);
    if (!existing) {
      throw new DomainAutoJoinRecoveryProblem("membership");
    }
    if (
      existing.eventId !== expectedEventId ||
      existing.eventStatus !== "completed" ||
      existing.membership === null
    ) {
      return { intent: structuredClone(existing), created: false };
    }

    const intent = structuredClone(input);
    this.autoJoinIntents.set(scope, intent);
    return { intent: structuredClone(intent), created: true };
  }

  async findAutoJoinIntent(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<DomainAutoJoinIntent | null> {
    const intent = this.autoJoinIntents.get(this.getAutoJoinScope(tenantId, idempotencyKey));
    return intent ? structuredClone(intent) : null;
  }

  async completeAutoJoinMembership(
    tenantId: string,
    idempotencyKey: string,
    membership: Membership,
    expectedEventId: string,
  ): Promise<DomainAutoJoinIntent | null> {
    const scope = this.getAutoJoinScope(tenantId, idempotencyKey);
    const intent = this.autoJoinIntents.get(scope);
    if (!intent) {
      return null;
    }

    if (intent.eventId !== expectedEventId || intent.membership !== null) {
      return structuredClone(intent);
    }

    const updated = { ...intent, membership: structuredClone(membership) };
    this.autoJoinIntents.set(scope, updated);
    return structuredClone(updated);
  }

  async claimAutoJoinEvent(
    tenantId: string,
    idempotencyKey: string,
    claimId: string,
    claimExpiresAt: Date,
    expectedEventId: string,
  ): Promise<DomainAutoJoinIntent | null> {
    const scope = this.getAutoJoinScope(tenantId, idempotencyKey);
    const intent = this.autoJoinIntents.get(scope);
    if (
      !intent?.membership ||
      intent.eventId !== expectedEventId ||
      intent.eventStatus === "completed" ||
      (intent.eventStatus === "processing" &&
        intent.eventClaimExpiresAt !== null &&
        intent.eventClaimExpiresAt.getTime() > Date.now())
    ) {
      return null;
    }

    const updated: DomainAutoJoinIntent = {
      ...intent,
      eventStatus: "processing",
      eventClaimId: claimId,
      eventClaimExpiresAt: claimExpiresAt,
    };
    this.autoJoinIntents.set(scope, updated);
    return structuredClone(updated);
  }

  async completeAutoJoinEvent(
    tenantId: string,
    idempotencyKey: string,
    claimId: string,
  ): Promise<DomainAutoJoinIntent | null> {
    const scope = this.getAutoJoinScope(tenantId, idempotencyKey);
    const intent = this.autoJoinIntents.get(scope);
    if (!intent || intent.eventStatus !== "processing" || intent.eventClaimId !== claimId) {
      return null;
    }

    const updated: DomainAutoJoinIntent = {
      ...intent,
      eventStatus: "completed",
      eventClaimId: null,
      eventClaimExpiresAt: null,
    };
    this.autoJoinIntents.set(scope, updated);
    return structuredClone(updated);
  }

  async releaseAutoJoinEvent(
    tenantId: string,
    idempotencyKey: string,
    claimId: string,
  ): Promise<void> {
    const scope = this.getAutoJoinScope(tenantId, idempotencyKey);
    const intent = this.autoJoinIntents.get(scope);
    if (!intent || intent.eventStatus !== "processing" || intent.eventClaimId !== claimId) {
      return;
    }

    this.autoJoinIntents.set(scope, {
      ...intent,
      eventStatus: "pending",
      eventClaimId: null,
      eventClaimExpiresAt: null,
    });
  }

  async deleteUncommittedAutoJoinIntent(
    tenantId: string,
    idempotencyKey: string,
    expectedEventId: string,
  ): Promise<void> {
    const scope = this.getAutoJoinScope(tenantId, idempotencyKey);
    const intent = this.autoJoinIntents.get(scope);
    if (intent && intent.eventId === expectedEventId && intent.membership === null) {
      this.autoJoinIntents.delete(scope);
    }
  }

  private getKey(tenantId: string, domain: string): string {
    return JSON.stringify([tenantId, domain]);
  }

  private getAutoJoinScope(tenantId: string, idempotencyKey: string): string {
    return JSON.stringify([tenantId, idempotencyKey]);
  }
}
