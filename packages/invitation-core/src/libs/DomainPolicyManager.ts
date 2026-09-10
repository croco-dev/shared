import { randomUUID } from "node:crypto";
// Runtime values required for constructor metadata.
// oxlint-disable-next-line typescript/consistent-type-imports
import { EventPublisher } from "@croco/events-core";
import { Component } from "@croco/framework-context";
import { AlreadyMemberProblem, MembershipNotFoundProblem } from "@croco/membership-core";
// oxlint-disable-next-line typescript/consistent-type-imports
import { MembershipManager } from "@croco/membership-core";
import type { Membership, MembershipRole } from "@croco/membership-core";
// oxlint-disable-next-line typescript/consistent-type-imports
import { TxManager } from "@croco/tx-core";
// oxlint-disable-next-line typescript/consistent-type-imports
import { DomainPolicyStore } from "./DomainPolicyStore";
import {
  DomainAutoJoinedEvent,
  DomainPolicyAddedEvent,
  DomainPolicyRemovedEvent,
} from "./events/DomainPolicyEvents";
import {
  DomainAutoJoinRecoveryProblem,
  InvalidAutoJoinRoleProblem,
  PublicEmailDomainNotAllowedProblem,
} from "./problems/DomainPolicyProblems";
import { hashToken } from "./token";
import { PUBLIC_EMAIL_DOMAINS } from "./types";
import type { DomainAutoJoinIntent, DomainPolicy } from "./types";

const AUTO_JOIN_ROLES: MembershipRole[] = ["member", "viewer"];
const AUTO_JOIN_EVENT_CLAIM_LEASE_MS = 5 * 60 * 1000;

type AutoJoinCleanupOperation = "releaseAutoJoinEvent";

function attachAutoJoinCleanupError(originalError: unknown, cleanupError: unknown): void {
  if (typeof originalError !== "object" || originalError === null) {
    return;
  }

  try {
    Object.defineProperty(originalError, "autoJoinCleanupError", {
      configurable: true,
      enumerable: false,
      value: cleanupError,
    });
  } catch {
    return;
  }
}

function reportAutoJoinCleanupError(
  operation: AutoJoinCleanupOperation,
  originalError: unknown,
  cleanupError: unknown,
): void {
  attachAutoJoinCleanupError(originalError, cleanupError);

  try {
    console.error("[DomainPolicyManager] Failed to clean up auto-join state", {
      operation,
      originalError,
      cleanupError,
    });
  } catch {
    return;
  }
}

async function runAutoJoinCleanup(
  operation: AutoJoinCleanupOperation,
  originalError: unknown,
  cleanup: () => Promise<void>,
): Promise<void> {
  try {
    await cleanup();
  } catch (cleanupError) {
    reportAutoJoinCleanupError(operation, originalError, cleanupError);
  }
}

@Component()
export class DomainPolicyManager {
  constructor(
    private readonly store: DomainPolicyStore,
    private readonly membershipManager: MembershipManager,
    private readonly eventPublisher: EventPublisher,
    private readonly txManager: TxManager<unknown>,
  ) {}

  async addDomainPolicy(
    tenantId: string,
    domain: string,
    role: MembershipRole,
  ): Promise<DomainPolicy> {
    this.ensureAutoJoinRole(role);

    const normalizedDomain = this.normalizeDomain(domain);
    this.ensureNonPublicDomain(normalizedDomain);

    const policy = await this.store.save({
      id: randomUUID(),
      tenantId,
      domain: normalizedDomain,
      role,
      enabled: true,
      createdAt: new Date(),
    });

    await this.publishSafely(
      new DomainPolicyAddedEvent({ tenantId, domain: normalizedDomain, role }),
    );
    return policy;
  }

  async removeDomainPolicy(tenantId: string, domain: string): Promise<void> {
    const normalizedDomain = this.normalizeDomain(domain);
    await this.store.delete(tenantId, normalizedDomain);
    await this.publishSafely(new DomainPolicyRemovedEvent({ tenantId, domain: normalizedDomain }));
  }

  async listDomainPolicies(tenantId: string): Promise<DomainPolicy[]> {
    return this.store.findAllByTenant(tenantId);
  }

  async tryAutoJoin(tenantId: string, userId: string, email: string): Promise<Membership | null> {
    const domain = this.extractEmailDomain(email);
    if (!domain) {
      return null;
    }

    const normalizedEmail = email.trim().toLowerCase();
    const idempotencyKey = this.createAutoJoinIdempotencyKey(tenantId, userId, normalizedEmail);
    const outcome = await this.txManager.runWithOutcome(async () => {
      let intent = await this.store.findAutoJoinIntent(tenantId, idempotencyKey);
      let previousEventId: string | undefined;
      if (intent?.membership && intent.eventStatus === "completed") {
        try {
          return await this.membershipManager.getMember(tenantId, userId);
        } catch (error) {
          if (!(error instanceof MembershipNotFoundProblem)) throw error;
        }
        previousEventId = intent.eventId;
      }

      if (!intent || previousEventId !== undefined) {
        const policy = await this.store.findByTenantAndDomain(tenantId, domain);
        if (!policy || !policy.enabled) return null;

        const event = new DomainAutoJoinedEvent({
          tenantId,
          userId,
          email: normalizedEmail,
          domain,
          role: policy.role,
        });
        const input: DomainAutoJoinIntent = {
          idempotencyKey,
          tenantId,
          userId,
          email: normalizedEmail,
          domain,
          role: policy.role,
          membership: null,
          eventStatus: "pending",
          eventClaimId: null,
          eventClaimExpiresAt: null,
          eventId: event.eventId,
          eventOccurredAt: event.timestamp,
          createdAt: new Date(),
        };
        const creation =
          previousEventId === undefined
            ? await this.store.createAutoJoinIntent(input)
            : await this.store.renewAutoJoinIntent(input, previousEventId);
        intent = creation.intent;
        if (!creation.created && intent.eventStatus === "completed") {
          return this.membershipManager.getMember(tenantId, userId);
        }
      }

      if (!intent.membership) {
        try {
          await this.membershipManager.getMember(tenantId, userId);
        } catch (error) {
          if (!(error instanceof MembershipNotFoundProblem)) throw error;
          const policy = await this.store.findByTenantAndDomain(tenantId, domain);
          if (!policy || !policy.enabled) return null;
          if (policy.role !== intent.role) throw new DomainAutoJoinRecoveryProblem("membership");
        }
        try {
          const membershipResult = await this.membershipManager.addMemberCommand(
            intent.tenantId,
            intent.userId,
            intent.role,
            `domain-auto-join:${intent.eventId}`,
          );
          const completed = await this.store.completeAutoJoinMembership(
            intent.tenantId,
            intent.idempotencyKey,
            membershipResult.membership,
            intent.eventId,
          );
          if (!completed?.membership || completed.eventId !== intent.eventId) {
            throw new DomainAutoJoinRecoveryProblem("membership");
          }
          intent = completed;
        } catch (error) {
          if (error instanceof AlreadyMemberProblem) return null;
          throw error;
        }
      }

      if (intent.eventStatus !== "completed") {
        const claimId = randomUUID();
        const claimed = await this.store.claimAutoJoinEvent(
          intent.tenantId,
          intent.idempotencyKey,
          claimId,
          new Date(Date.now() + AUTO_JOIN_EVENT_CLAIM_LEASE_MS),
          intent.eventId,
        );
        if (claimed) {
          this.txManager.onAfterCommit(() => this.publishClaimedAutoJoinEvent(claimed, claimId));
        } else {
          const latest = await this.store.findAutoJoinIntent(
            intent.tenantId,
            intent.idempotencyKey,
          );
          if (latest?.eventStatus !== "completed" || latest.eventId !== intent.eventId) {
            throw new DomainAutoJoinRecoveryProblem("event");
          }
        }
      }

      return intent.membership;
    });

    if (outcome.afterCommit.status === "failed") {
      throw outcome.afterCommit.problem;
    }

    return outcome.value;
  }

  private createAutoJoinIdempotencyKey(
    tenantId: string,
    userId: string,
    normalizedEmail: string,
  ): string {
    return hashToken(JSON.stringify(["domain-auto-join", tenantId, userId, normalizedEmail]));
  }

  private async publishClaimedAutoJoinEvent(
    intent: DomainAutoJoinIntent,
    claimId: string,
  ): Promise<void> {
    try {
      const event = new DomainAutoJoinedEvent({
        tenantId: intent.tenantId,
        userId: intent.userId,
        email: intent.email,
        domain: intent.domain,
        role: intent.role,
      });
      const eventIdentity = event as unknown as { eventId: string; timestamp: Date };
      eventIdentity.eventId = intent.eventId;
      eventIdentity.timestamp = new Date(intent.eventOccurredAt);
      await this.publishSafely(event);
      const completed = await this.store.completeAutoJoinEvent(
        intent.tenantId,
        intent.idempotencyKey,
        claimId,
      );
      if (!completed || completed.eventStatus !== "completed") {
        throw new DomainAutoJoinRecoveryProblem("event");
      }
    } catch (error) {
      await runAutoJoinCleanup("releaseAutoJoinEvent", error, () =>
        this.store.releaseAutoJoinEvent(intent.tenantId, intent.idempotencyKey, claimId),
      );
      throw error;
    }
  }

  private normalizeDomain(domain: string): string {
    return domain.trim().toLowerCase().replace(/^@+/, "");
  }

  private extractEmailDomain(email: string): string | null {
    const normalizedEmail = email.trim().toLowerCase();
    const match = /^[^@\s]+@([^@\s]+)$/u.exec(normalizedEmail);
    if (!match) {
      return null;
    }

    const [, domain] = match;
    const normalizedDomain = this.normalizeDomain(domain);
    return normalizedDomain ? normalizedDomain : null;
  }

  private ensureNonPublicDomain(domain: string): void {
    if (PUBLIC_EMAIL_DOMAINS.includes(domain as (typeof PUBLIC_EMAIL_DOMAINS)[number])) {
      throw new PublicEmailDomainNotAllowedProblem(domain);
    }
  }

  private ensureAutoJoinRole(role: MembershipRole): void {
    if (!AUTO_JOIN_ROLES.includes(role)) {
      throw new InvalidAutoJoinRoleProblem(role);
    }
  }

  private async publishSafely(
    event: DomainPolicyAddedEvent | DomainPolicyRemovedEvent | DomainAutoJoinedEvent,
  ): Promise<void> {
    await this.eventPublisher.publishNow(event);
  }
}
