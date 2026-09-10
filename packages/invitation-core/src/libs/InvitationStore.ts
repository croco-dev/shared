import type {
  EmailInvitationCreation,
  EmailInvitationCreationInput,
  Invitation,
  InvitationStatus,
} from "./types";

export abstract class InvitationStore {
  abstract findById(id: string): Promise<Invitation | null>;
  abstract findByTokenHash(tokenHash: string): Promise<Invitation | null>;
  abstract findByTenantAndEmail(tenantId: string, email: string): Promise<Invitation | null>;
  abstract findAllByTenant(tenantId: string): Promise<Invitation[]>;
  abstract save(invitation: Invitation): Promise<Invitation>;
  abstract createEmailInvitation(
    input: EmailInvitationCreationInput,
  ): Promise<EmailInvitationCreation>;
  abstract findEmailInvitationCreation(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<EmailInvitationCreation | null>;
  abstract claimEmailInvitationNotification(
    tenantId: string,
    idempotencyKey: string,
    claimId: string,
    claimExpiresAt: Date,
  ): Promise<EmailInvitationCreation | null>;
  abstract claimEmailInvitationEvent(
    tenantId: string,
    idempotencyKey: string,
    claimId: string,
    claimExpiresAt: Date,
  ): Promise<EmailInvitationCreation | null>;
  abstract completeEmailInvitationNotification(
    tenantId: string,
    idempotencyKey: string,
    claimId: string,
  ): Promise<EmailInvitationCreation | null>;
  abstract completeEmailInvitationEvent(
    tenantId: string,
    idempotencyKey: string,
    claimId: string,
  ): Promise<EmailInvitationCreation | null>;
  abstract releaseEmailInvitationNotification(
    tenantId: string,
    idempotencyKey: string,
    claimId: string,
  ): Promise<void>;
  abstract releaseEmailInvitationEvent(
    tenantId: string,
    idempotencyKey: string,
    claimId: string,
  ): Promise<void>;
  abstract activateEmailInvitation(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<EmailInvitationCreation | null>;
  abstract deleteExpiredEmailInvitationCreations(now: Date): Promise<number>;
  abstract updateStatus(
    tenantId: string,
    id: string,
    status: InvitationStatus,
  ): Promise<Invitation | null>;
  abstract compareAndSetStatus(
    tenantId: string,
    id: string,
    expected: InvitationStatus,
    desired: InvitationStatus,
    meta?: { acceptedAt?: Date; rejectedAt?: Date },
  ): Promise<Invitation | null>;
  /** Count all invitations created at or after since for this tenant, regardless of status. */
  abstract countIssuedByTenant(tenantId: string, since: Date): Promise<number>;
  abstract countPendingByTenant(tenantId: string, since: Date): Promise<number>;
}
