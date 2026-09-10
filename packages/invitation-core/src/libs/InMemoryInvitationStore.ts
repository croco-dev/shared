import { InvitationStore } from "./InvitationStore";
import { InvitationIdempotencyConflictProblem } from "./problems/InvitationProblems";
import type {
  EmailInvitationCreation,
  EmailInvitationCreationInput,
  Invitation,
  InvitationStatus,
} from "./types";

const snapshotInvitation = (invitation: Invitation): Invitation => structuredClone(invitation);

export class InMemoryInvitationStore extends InvitationStore {
  private readonly storage = new Map<string, Invitation>();
  private readonly emailCreations = new Map<string, EmailInvitationCreation>();

  async findById(id: string): Promise<Invitation | null> {
    const invitation = this.storage.get(id);
    return invitation ? snapshotInvitation(invitation) : null;
  }

  async findByTokenHash(tokenHash: string): Promise<Invitation | null> {
    for (const invitation of this.storage.values()) {
      if (invitation.tokenHash === tokenHash) {
        return snapshotInvitation(invitation);
      }
    }

    return null;
  }

  async findByTenantAndEmail(tenantId: string, email: string): Promise<Invitation | null> {
    const now = Date.now();
    const invitation = [...this.storage.values()]
      .filter((candidate) => candidate.tenantId === tenantId && candidate.email === email)
      .sort((left, right) => {
        const livePendingOrder =
          Number(right.status === "pending" && right.expiresAt.getTime() > now) -
          Number(left.status === "pending" && left.expiresAt.getTime() > now);
        if (livePendingOrder !== 0) {
          return livePendingOrder;
        }

        const createdAtOrder = right.createdAt.getTime() - left.createdAt.getTime();
        return createdAtOrder !== 0 ? createdAtOrder : right.id.localeCompare(left.id);
      })[0];

    return invitation ? snapshotInvitation(invitation) : null;
  }

  async findAllByTenant(tenantId: string): Promise<Invitation[]> {
    return [...this.storage.values()]
      .filter((invitation) => invitation.tenantId === tenantId)
      .map(snapshotInvitation);
  }

  async save(invitation: Invitation): Promise<Invitation> {
    const stored = snapshotInvitation(invitation);
    this.storage.set(stored.id, stored);
    return snapshotInvitation(stored);
  }

  async createEmailInvitation(
    input: EmailInvitationCreationInput,
  ): Promise<EmailInvitationCreation> {
    const scope = this.creationScope(input.invitation.tenantId, input.idempotencyKey);
    const existing = this.emailCreations.get(scope);

    if (existing) {
      if (existing.requestFingerprint !== input.requestFingerprint) {
        throw new InvitationIdempotencyConflictProblem(input.idempotencyKey);
      }
      if (existing.invitation.expiresAt.getTime() > Date.now()) {
        return structuredClone(existing);
      }
      this.storage.set(existing.invitation.id, {
        ...existing.invitation,
        status: "expired",
      });
      this.emailCreations.delete(scope);
    }

    const creation = structuredClone(input);
    this.storage.set(creation.invitation.id, creation.invitation);
    this.emailCreations.set(scope, creation);
    return structuredClone(creation);
  }

  async findEmailInvitationCreation(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<EmailInvitationCreation | null> {
    const creation = this.emailCreations.get(this.creationScope(tenantId, idempotencyKey));
    return creation ? structuredClone(creation) : null;
  }

  async claimEmailInvitationNotification(
    tenantId: string,
    idempotencyKey: string,
    claimId: string,
    claimExpiresAt: Date,
  ): Promise<EmailInvitationCreation | null> {
    return this.claimCreationPhase(
      tenantId,
      idempotencyKey,
      "notificationStatus",
      "notificationClaimId",
      "notificationClaimExpiresAt",
      claimId,
      claimExpiresAt,
    );
  }

  async claimEmailInvitationEvent(
    tenantId: string,
    idempotencyKey: string,
    claimId: string,
    claimExpiresAt: Date,
  ): Promise<EmailInvitationCreation | null> {
    return this.claimCreationPhase(
      tenantId,
      idempotencyKey,
      "eventStatus",
      "eventClaimId",
      "eventClaimExpiresAt",
      claimId,
      claimExpiresAt,
    );
  }

  async completeEmailInvitationNotification(
    tenantId: string,
    idempotencyKey: string,
    claimId: string,
  ): Promise<EmailInvitationCreation | null> {
    return this.completeCreationPhase(
      tenantId,
      idempotencyKey,
      "notificationStatus",
      "notificationClaimId",
      "notificationClaimExpiresAt",
      claimId,
    );
  }

  async completeEmailInvitationEvent(
    tenantId: string,
    idempotencyKey: string,
    claimId: string,
  ): Promise<EmailInvitationCreation | null> {
    return this.completeCreationPhase(
      tenantId,
      idempotencyKey,
      "eventStatus",
      "eventClaimId",
      "eventClaimExpiresAt",
      claimId,
    );
  }

  async releaseEmailInvitationNotification(
    tenantId: string,
    idempotencyKey: string,
    claimId: string,
  ): Promise<void> {
    this.releaseCreationPhase(
      tenantId,
      idempotencyKey,
      "notificationStatus",
      "notificationClaimId",
      "notificationClaimExpiresAt",
      claimId,
    );
  }

  async releaseEmailInvitationEvent(
    tenantId: string,
    idempotencyKey: string,
    claimId: string,
  ): Promise<void> {
    this.releaseCreationPhase(
      tenantId,
      idempotencyKey,
      "eventStatus",
      "eventClaimId",
      "eventClaimExpiresAt",
      claimId,
    );
  }

  async activateEmailInvitation(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<EmailInvitationCreation | null> {
    const scope = this.creationScope(tenantId, idempotencyKey);
    const creation = this.emailCreations.get(scope);
    if (
      !creation ||
      creation.notificationStatus !== "completed" ||
      creation.eventStatus !== "completed"
    ) {
      return creation ? structuredClone(creation) : null;
    }

    const invitation = { ...creation.invitation, status: "pending" as const };
    const updated = { ...creation, invitation };
    this.storage.set(invitation.id, invitation);
    this.emailCreations.set(scope, updated);
    return structuredClone(updated);
  }

  async deleteExpiredEmailInvitationCreations(now: Date): Promise<number> {
    let deleted = 0;
    for (const [scope, creation] of this.emailCreations) {
      if (creation.invitation.expiresAt.getTime() <= now.getTime()) {
        this.storage.set(creation.invitation.id, {
          ...creation.invitation,
          status: "expired",
        });
        this.emailCreations.delete(scope);
        deleted += 1;
      }
    }
    return deleted;
  }

  async updateStatus(
    tenantId: string,
    id: string,
    status: InvitationStatus,
  ): Promise<Invitation | null> {
    const invitation = this.storage.get(id);
    if (!invitation || invitation.tenantId !== tenantId) {
      return null;
    }

    const updated = snapshotInvitation({
      ...invitation,
      status,
    });

    this.storage.set(id, updated);
    return snapshotInvitation(updated);
  }

  async compareAndSetStatus(
    tenantId: string,
    id: string,
    expected: InvitationStatus,
    desired: InvitationStatus,
    meta: { acceptedAt?: Date; rejectedAt?: Date } = {},
  ): Promise<Invitation | null> {
    const invitation = this.storage.get(id);
    if (!invitation || invitation.tenantId !== tenantId || invitation.status !== expected) {
      return null;
    }

    const transitionTime = Date.now();
    const acceptedAt =
      desired === "accepted"
        ? new Date(Math.max(meta.acceptedAt?.getTime() ?? transitionTime, transitionTime))
        : meta.acceptedAt;
    if (
      acceptedAt &&
      desired === "accepted" &&
      invitation.expiresAt.getTime() <= acceptedAt.getTime()
    ) {
      return null;
    }

    const updated = snapshotInvitation({
      ...invitation,
      status: desired,
      acceptedAt: acceptedAt ?? invitation.acceptedAt,
    });

    this.storage.set(id, updated);
    return snapshotInvitation(updated);
  }

  async countIssuedByTenant(tenantId: string, since: Date): Promise<number> {
    let count = 0;

    for (const invitation of this.storage.values()) {
      if (invitation.tenantId === tenantId && invitation.createdAt >= since) {
        count += 1;
      }
    }

    return count;
  }

  async countPendingByTenant(tenantId: string, since: Date): Promise<number> {
    let count = 0;

    for (const invitation of this.storage.values()) {
      if (
        invitation.tenantId === tenantId &&
        invitation.status === "pending" &&
        invitation.createdAt >= since
      ) {
        count += 1;
      }
    }

    return count;
  }

  private claimCreationPhase(
    tenantId: string,
    idempotencyKey: string,
    phase: "notificationStatus" | "eventStatus",
    claimField: "notificationClaimId" | "eventClaimId",
    expiryField: "notificationClaimExpiresAt" | "eventClaimExpiresAt",
    claimId: string,
    claimExpiresAt: Date,
  ): EmailInvitationCreation | null {
    const scope = this.creationScope(tenantId, idempotencyKey);
    const creation = this.emailCreations.get(scope);
    const existingExpiry = creation?.[expiryField];
    if (
      !creation ||
      creation[phase] === "completed" ||
      (creation[phase] === "processing" &&
        existingExpiry !== null &&
        existingExpiry !== undefined &&
        existingExpiry.getTime() > Date.now())
    ) {
      return null;
    }

    const updated = {
      ...creation,
      [phase]: "processing" as const,
      [claimField]: claimId,
      [expiryField]: claimExpiresAt,
    };
    this.emailCreations.set(scope, updated);
    return structuredClone(updated);
  }

  private completeCreationPhase(
    tenantId: string,
    idempotencyKey: string,
    phase: "notificationStatus" | "eventStatus",
    claimField: "notificationClaimId" | "eventClaimId",
    expiryField: "notificationClaimExpiresAt" | "eventClaimExpiresAt",
    claimId: string,
  ): EmailInvitationCreation | null {
    const scope = this.creationScope(tenantId, idempotencyKey);
    const creation = this.emailCreations.get(scope);
    if (!creation || creation[phase] !== "processing" || creation[claimField] !== claimId) {
      return null;
    }

    const updated = {
      ...creation,
      [phase]: "completed" as const,
      [claimField]: null,
      [expiryField]: null,
    };
    this.emailCreations.set(scope, updated);
    return structuredClone(updated);
  }

  private releaseCreationPhase(
    tenantId: string,
    idempotencyKey: string,
    phase: "notificationStatus" | "eventStatus",
    claimField: "notificationClaimId" | "eventClaimId",
    expiryField: "notificationClaimExpiresAt" | "eventClaimExpiresAt",
    claimId: string,
  ): void {
    const scope = this.creationScope(tenantId, idempotencyKey);
    const creation = this.emailCreations.get(scope);
    if (!creation || creation[phase] !== "processing" || creation[claimField] !== claimId) {
      return;
    }

    this.emailCreations.set(scope, {
      ...creation,
      [phase]: "pending",
      [claimField]: null,
      [expiryField]: null,
    });
  }

  private creationScope(tenantId: string, idempotencyKey: string): string {
    return `${encodeURIComponent(tenantId)}:${encodeURIComponent(idempotencyKey)}`;
  }
}
