import type { Membership } from "@croco/membership-core";
import type {
  DomainAutoJoinIntent,
  DomainAutoJoinIntentCreation,
  DomainAutoJoinIntentInput,
  DomainPolicy,
} from "./types";

export abstract class DomainPolicyStore {
  abstract findByTenantAndDomain(tenantId: string, domain: string): Promise<DomainPolicy | null>;
  abstract findAllByTenant(tenantId: string): Promise<DomainPolicy[]>;
  abstract save(policy: DomainPolicy): Promise<DomainPolicy>;
  abstract delete(tenantId: string, domain: string): Promise<void>;
  abstract createAutoJoinIntent(
    input: DomainAutoJoinIntentInput,
  ): Promise<DomainAutoJoinIntentCreation>;
  /**
   * Atomically replaces the tenant/key intent only when its event ID matches,
   * its event is completed, and its membership is non-null.
   * Returns created=true only for the winner; otherwise returns the current intent.
   * Throws DomainAutoJoinRecoveryProblem when the intent no longer exists.
   */
  abstract renewAutoJoinIntent(
    input: DomainAutoJoinIntentInput,
    expectedEventId: string,
  ): Promise<DomainAutoJoinIntentCreation>;
  abstract findAutoJoinIntent(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<DomainAutoJoinIntent | null>;
  abstract completeAutoJoinMembership(
    tenantId: string,
    idempotencyKey: string,
    membership: Membership,
    expectedEventId: string,
  ): Promise<DomainAutoJoinIntent | null>;
  abstract claimAutoJoinEvent(
    tenantId: string,
    idempotencyKey: string,
    claimId: string,
    claimExpiresAt: Date,
    expectedEventId: string,
  ): Promise<DomainAutoJoinIntent | null>;
  abstract completeAutoJoinEvent(
    tenantId: string,
    idempotencyKey: string,
    claimId: string,
  ): Promise<DomainAutoJoinIntent | null>;
  abstract releaseAutoJoinEvent(
    tenantId: string,
    idempotencyKey: string,
    claimId: string,
  ): Promise<void>;
  abstract deleteUncommittedAutoJoinIntent(
    tenantId: string,
    idempotencyKey: string,
    expectedEventId: string,
  ): Promise<void>;
}
