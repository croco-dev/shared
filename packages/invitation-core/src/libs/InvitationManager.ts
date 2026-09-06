// Constructor dependencies must remain runtime values for emitted design:paramtypes metadata.
/* oxlint-disable typescript/consistent-type-imports */
import { randomUUID } from "node:crypto";
import { EventPublisher } from "@croco/events-core";
import { Component } from "@croco/framework-context";
import { AbstractMembershipManager, type MembershipRole } from "@croco/membership-core";
import {
  createNotificationIdempotencyKey,
  NotificationChannel,
  type NotificationPayload,
  NotificationService,
} from "@croco/notifications-core";
import { Problem } from "@croco/problems-core";
import { recordError, recordEvent } from "@croco/telemetry-api";
import { TxManager, type TxRunOutcome } from "@croco/tx-core";
import {
  InvitationAcceptedEvent,
  InvitationCreatedEvent,
  InvitationDeclinedEvent,
  InvitationRevokedEvent,
} from "./events/InvitationEvents";
import { InvitationStore } from "./InvitationStore";
import {
  InvalidInvitationExpiryDurationProblem,
  InvitationAlreadyAcceptedProblem,
  InvitationCreationFailedProblem,
  InvitationEmailMismatchProblem,
  InvitationExpiredProblem,
  InvitationInvalidStatusProblem,
  InvitationNotFoundProblem,
} from "./problems/InvitationProblems";
import { generateToken, hashToken } from "./token";
import type {
  EmailInvitationCreation,
  Invitation,
  InvitationStatus,
  InvitationType,
} from "./types";

const DEFAULT_EMAIL_EXPIRES_IN_DAYS = 7;
const DEFAULT_LINK_EXPIRES_IN_DAYS = 30;
const CREATION_CLAIM_LEASE_MS = 5 * 60 * 1000;

export type CreateEmailInvitationInput = {
  idempotencyKey: string;
  tenantId: string;
  inviterId: string;
  email: string;
  role: MembershipRole;
  /** Positive integer number of calendar days. Fractional days are not supported. */
  expiresInDays?: number;
};

export type CreateLinkInvitationInput = {
  idempotencyKey: string;
  tenantId: string;
  inviterId: string;
  role: MembershipRole;
  /** Positive integer number of calendar days. Fractional days are not supported. */
  expiresInDays?: number;
};

export type AcceptInvitationInput = {
  token: string;
  userId: string;
  email?: string;
};

@Component()
export class InvitationManager {
  constructor(
    private readonly store: InvitationStore,
    private readonly membershipManager: AbstractMembershipManager,
    private readonly notificationService: NotificationService,
    private readonly eventPublisher: EventPublisher,
    private readonly txManager: TxManager<unknown>,
  ) {}

  async createEmailInvitation(input: CreateEmailInvitationInput): Promise<string> {
    const expiry = this.resolveExpiry(input.expiresInDays, "email");
    await this.deleteExpiredCreationIntentsSafely();
    const email = this.normalizeEmail(input.email);
    const token = generateToken();
    const invitation = this.buildInvitation({
      tenantId: input.tenantId,
      inviterId: input.inviterId,
      email,
      role: input.role,
      type: "email",
      token,
      ...expiry,
    });
    const event = this.createInvitationCreatedEvent(invitation);
    const notificationIdempotencyKey = this.createInvitationNotificationIdempotencyKey(
      invitation,
      input.idempotencyKey,
    );
    let creation;
    try {
      creation = await this.store.createEmailInvitation({
        invitation,
        token,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: hashToken(
          JSON.stringify([
            input.tenantId,
            input.inviterId,
            email,
            input.role,
            input.expiresInDays ?? DEFAULT_EMAIL_EXPIRES_IN_DAYS,
          ]),
        ),
        notificationIdempotencyKey,
        notificationStatus: "pending",
        notificationClaimId: null,
        notificationClaimExpiresAt: null,
        eventStatus: "pending",
        eventClaimId: null,
        eventClaimExpiresAt: null,
        eventId: event.eventId,
        eventOccurredAt: event.timestamp,
        createdAt: invitation.createdAt,
      });
    } catch (error) {
      if (error instanceof Problem) {
        throw error;
      }
      this.throwCreationPendingProblem(invitation.id, "persistence");
    }

    creation = await this.publishCreationEvent(creation);

    if (creation.notificationStatus !== "completed") {
      const claimId = randomUUID();
      const claimed = await this.store.claimEmailInvitationNotification(
        creation.invitation.tenantId,
        creation.idempotencyKey,
        claimId,
        new Date(Date.now() + CREATION_CLAIM_LEASE_MS),
      );
      if (!claimed) {
        this.throwCreationPendingProblem(creation.invitation.id, "notification");
      }
      try {
        await this.sendInvitationNotification(
          claimed.invitation,
          claimed.token,
          claimed.notificationIdempotencyKey,
        );
        const completed = await this.store.completeEmailInvitationNotification(
          claimed.invitation.tenantId,
          claimed.idempotencyKey,
          claimId,
        );
        if (!completed || completed.notificationStatus !== "completed") {
          this.throwCreationPendingProblem(claimed.invitation.id, "notification");
        }
        creation = completed;
      } catch {
        await this.releaseCreationClaimSafely("notification", claimed, claimId);
        this.throwCreationPendingProblem(claimed.invitation.id, "notification");
      }
    }

    try {
      const activated = await this.store.activateEmailInvitation(
        creation.invitation.tenantId,
        creation.idempotencyKey,
      );
      if (!activated || activated.invitation.status !== "pending") {
        this.throwCreationPendingProblem(creation.invitation.id, "persistence");
      }
      return activated.token;
    } catch (error) {
      if (error instanceof Problem) {
        throw error;
      }
      this.throwCreationPendingProblem(creation.invitation.id, "persistence");
    }
  }

  async createLinkInvitation(input: CreateLinkInvitationInput): Promise<string> {
    const expiry = this.resolveExpiry(input.expiresInDays, "link");
    await this.deleteExpiredCreationIntentsSafely();
    const token = generateToken();
    const invitation = this.buildInvitation({
      tenantId: input.tenantId,
      inviterId: input.inviterId,
      email: null,
      role: input.role,
      type: "link",
      token,
      ...expiry,
    });
    const event = this.createInvitationCreatedEvent(invitation);
    let creation;
    try {
      creation = await this.store.createEmailInvitation({
        invitation,
        token,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: hashToken(
          JSON.stringify([
            input.tenantId,
            input.inviterId,
            input.role,
            input.expiresInDays ?? DEFAULT_LINK_EXPIRES_IN_DAYS,
            "link",
            1,
          ]),
        ),
        notificationIdempotencyKey: `link:${input.idempotencyKey}`,
        notificationStatus: "completed",
        notificationClaimId: null,
        notificationClaimExpiresAt: null,
        eventStatus: "pending",
        eventClaimId: null,
        eventClaimExpiresAt: null,
        eventId: event.eventId,
        eventOccurredAt: event.timestamp,
        createdAt: invitation.createdAt,
      });
    } catch (error) {
      if (error instanceof Problem) {
        throw error;
      }
      this.throwCreationPendingProblem(invitation.id, "persistence");
    }

    creation = await this.publishCreationEvent(creation);

    try {
      const activated = await this.store.activateEmailInvitation(
        creation.invitation.tenantId,
        creation.idempotencyKey,
      );
      if (!activated || activated.invitation.status !== "pending") {
        this.throwCreationPendingProblem(creation.invitation.id, "persistence");
      }
      return activated.token;
    } catch (error) {
      if (error instanceof Problem) {
        throw error;
      }
      this.throwCreationPendingProblem(creation.invitation.id, "persistence");
    }
  }

  async acceptInvitation(input: AcceptInvitationInput): Promise<TxRunOutcome<Invitation>> {
    const invitation = await this.getByTokenOrThrow(input.token);
    this.ensureAcceptableStatus(invitation, "accept");

    if (this.isExpired(invitation)) {
      const expiredInvitation = await this.updateInvitation(invitation, {
        status: "expired",
      });
      throw new InvitationExpiredProblem(expiredInvitation.id);
    }

    if (invitation.type === "email") {
      const providedEmail = this.normalizeOptionalEmail(input.email);
      if (!providedEmail || providedEmail !== invitation.email) {
        throw new InvitationEmailMismatchProblem(invitation.id, invitation.email, providedEmail);
      }
    }

    return this.txManager.runWithOutcome(async () => {
      const accepted = await this.store.compareAndSetStatus(
        invitation.tenantId,
        invitation.id,
        "pending",
        "accepted",
      );

      if (!accepted) {
        const current = await this.store.findById(invitation.id);
        if (!current) {
          throw new InvitationNotFoundProblem("");
        }

        if (
          current.status === "expired" ||
          (current.status === "pending" && this.isExpired(current))
        ) {
          throw new InvitationExpiredProblem(current.id);
        }

        this.ensureAcceptableStatus(current, "accept");
        throw new InvitationInvalidStatusProblem(current.id, current.status, "accept");
      }

      await this.membershipManager.addMember(
        invitation.tenantId,
        input.userId,
        invitation.role,
        `invitation-accept:${invitation.id}:${input.userId}`,
      );

      this.txManager.onAfterCommit(() =>
        this.publishSafely(
          new InvitationAcceptedEvent({
            invitationId: accepted.id,
            tenantId: accepted.tenantId,
            userId: input.userId,
            email: accepted.email,
            role: accepted.role,
            type: accepted.type,
          }),
        ),
      );

      return accepted;
    });
  }

  async declineInvitation(token: string): Promise<Invitation> {
    const invitation = await this.getByTokenOrThrow(token);
    this.ensurePendingStatus(invitation, "decline");

    const declined = await this.store.compareAndSetStatus(
      invitation.tenantId,
      invitation.id,
      "pending",
      "declined",
    );
    if (!declined) {
      const current = await this.store.findById(invitation.id);
      if (!current) {
        throw new InvitationNotFoundProblem("");
      }
      throw new InvitationInvalidStatusProblem(current.id, current.status, "decline");
    }

    await this.publishSafely(
      new InvitationDeclinedEvent({
        invitationId: declined.id,
        tenantId: declined.tenantId,
        email: declined.email,
        role: declined.role,
        type: declined.type,
      }),
    );

    return declined;
  }

  async revokeInvitation(invitationId: string): Promise<Invitation> {
    const invitation = await this.store.findById(invitationId);
    if (!invitation) {
      throw new InvitationNotFoundProblem("");
    }

    if (invitation.status === "accepted") {
      throw new InvitationInvalidStatusProblem(invitation.id, invitation.status, "revoke");
    }

    if (invitation.status === "revoked") {
      return invitation;
    }

    const revoked = await this.updateInvitation(invitation, {
      status: "revoked",
      revokedAt: new Date(),
    });

    await this.publishSafely(
      new InvitationRevokedEvent({
        invitationId: revoked.id,
        tenantId: revoked.tenantId,
        email: revoked.email,
        role: revoked.role,
        type: revoked.type,
      }),
    );

    return revoked;
  }

  async resendInvitation(invitationId: string, idempotencyKey: string): Promise<string> {
    const invitation = await this.store.findById(invitationId);
    if (!invitation) {
      throw new InvitationNotFoundProblem("");
    }

    if (invitation.status === "accepted") {
      throw new InvitationInvalidStatusProblem(invitation.id, invitation.status, "resend");
    }

    await this.revokeInvitation(invitation.id);

    if (invitation.type === "email") {
      const token = await this.createEmailInvitation({
        idempotencyKey,
        tenantId: invitation.tenantId,
        inviterId: invitation.inviterId,
        email: invitation.email ?? "",
        role: invitation.role,
      });
      return token;
    }

    return this.createLinkInvitation({
      idempotencyKey,
      tenantId: invitation.tenantId,
      inviterId: invitation.inviterId,
      role: invitation.role,
    });
  }

  private buildInvitation(input: {
    tenantId: string;
    inviterId: string;
    email: string | null;
    role: MembershipRole;
    type: InvitationType;
    token: string;
    createdAt: Date;
    expiresAt: Date;
  }): Invitation {
    return {
      id: randomUUID(),
      tenantId: input.tenantId,
      inviterId: input.inviterId,
      email: input.email,
      tokenHash: hashToken(input.token),
      type: input.type,
      role: input.role,
      status: "creating",
      expiresAt: input.expiresAt,
      acceptedAt: null,
      revokedAt: null,
      createdAt: input.createdAt,
    };
  }

  private resolveExpiry(
    expiresInDays: number | undefined,
    type: InvitationType,
  ): { createdAt: Date; expiresAt: Date } {
    const duration =
      expiresInDays ??
      (type === "email" ? DEFAULT_EMAIL_EXPIRES_IN_DAYS : DEFAULT_LINK_EXPIRES_IN_DAYS);

    if (!Number.isSafeInteger(duration) || duration <= 0) {
      throw new InvalidInvitationExpiryDurationProblem(duration);
    }

    const createdAt = new Date();
    const expiresAt = this.addDays(createdAt, duration);
    if (!Number.isFinite(expiresAt.getTime())) {
      throw new InvalidInvitationExpiryDurationProblem(duration);
    }

    return { createdAt, expiresAt };
  }

  private async getByTokenOrThrow(token: string): Promise<Invitation> {
    const tokenHash = hashToken(token);
    const invitation = await this.store.findByTokenHash(tokenHash);

    if (!invitation) {
      throw new InvitationNotFoundProblem("");
    }

    return invitation;
  }

  private ensureAcceptableStatus(invitation: Invitation, operation: string): void {
    if (invitation.status === "accepted") {
      throw new InvitationAlreadyAcceptedProblem(invitation.id);
    }

    if (invitation.status !== "pending") {
      throw new InvitationInvalidStatusProblem(invitation.id, invitation.status, operation);
    }
  }

  private ensurePendingStatus(invitation: Invitation, operation: string): void {
    if (invitation.status !== "pending") {
      throw new InvitationInvalidStatusProblem(invitation.id, invitation.status, operation);
    }

    if (this.isExpired(invitation)) {
      throw new InvitationExpiredProblem(invitation.id);
    }
  }

  private isExpired(invitation: Invitation): boolean {
    return invitation.expiresAt.getTime() <= Date.now();
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private normalizeOptionalEmail(email?: string): string | null {
    if (!email) {
      return null;
    }

    const normalized = email.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
  }

  private addDays(base: Date, days: number): Date {
    const result = new Date(base);
    result.setDate(result.getDate() + days);
    return result;
  }

  private async sendInvitationNotification(
    invitation: Invitation,
    token: string,
    idempotencyKey: string,
  ): Promise<void> {
    if (!invitation.email) {
      return;
    }

    const payload: NotificationPayload = {
      to: invitation.email,
      subject: "You are invited to join tenant",
      content: `Use this invitation token: ${token}`,
      metadata: {
        invitationId: invitation.id,
        tenantId: invitation.tenantId,
        inviterId: invitation.inviterId,
      },
    };

    const preferenceContext = {
      tenantId: invitation.tenantId,
      userId: invitation.email,
      channel: NotificationChannel.EMAIL,
      topic: "invitation.created",
    };

    await this.notificationService.send(NotificationChannel.EMAIL, payload, {
      idempotencyKey,
      preferenceContext,
      requireProviderIdempotency: true,
    });
  }

  private createInvitationNotificationIdempotencyKey(
    invitation: Invitation,
    semanticKey: string,
  ): string {
    const email = invitation.email ?? "";
    return createNotificationIdempotencyKey({
      tenantId: invitation.tenantId,
      userId: email,
      channel: NotificationChannel.EMAIL,
      topic: "invitation.created",
      recipient: email,
      semanticKey,
    });
  }

  private createInvitationCreatedEvent(invitation: Invitation): InvitationCreatedEvent {
    return new InvitationCreatedEvent({
      invitationId: invitation.id,
      tenantId: invitation.tenantId,
      inviterId: invitation.inviterId,
      email: invitation.email,
      role: invitation.role,
      type: invitation.type,
      expiresAt: invitation.expiresAt,
    });
  }

  private async updateInvitation(
    invitation: Invitation,
    patch: {
      status?: InvitationStatus;
      acceptedAt?: Date | null;
      revokedAt?: Date | null;
    },
  ): Promise<Invitation> {
    const updated: Invitation = {
      ...invitation,
      status: patch.status ?? invitation.status,
      acceptedAt: patch.acceptedAt ?? invitation.acceptedAt,
      revokedAt: patch.revokedAt ?? invitation.revokedAt,
    };

    await this.store.save(updated);
    return updated;
  }

  private async publishSafely(
    event:
      | InvitationCreatedEvent
      | InvitationAcceptedEvent
      | InvitationRevokedEvent
      | InvitationDeclinedEvent,
  ): Promise<void> {
    await this.eventPublisher.publishNow(event);
  }

  private throwCreationPendingProblem(
    invitationId: string,
    phase: "persistence" | "notification" | "event",
  ): never {
    const problem = new InvitationCreationFailedProblem(invitationId, phase);
    recordEvent("invitation.creation.pending", {
      "invitation.id": invitationId,
      "invitation.phase": phase,
    });
    recordError(problem);
    throw problem;
  }

  private async releaseCreationClaimSafely(
    phase: "notification" | "event",
    creation: { invitation: Invitation; idempotencyKey: string },
    claimId: string,
  ): Promise<void> {
    try {
      if (phase === "notification") {
        await this.store.releaseEmailInvitationNotification(
          creation.invitation.tenantId,
          creation.idempotencyKey,
          claimId,
        );
        return;
      }
      await this.store.releaseEmailInvitationEvent(
        creation.invitation.tenantId,
        creation.idempotencyKey,
        claimId,
      );
    } catch {
      recordEvent("invitation.creation.claim_release_failed", {
        "invitation.id": creation.invitation.id,
        "invitation.phase": phase,
      });
    }
  }

  private async publishCreationEvent(
    creation: EmailInvitationCreation,
  ): Promise<EmailInvitationCreation> {
    if (creation.eventStatus === "completed") {
      return creation;
    }

    const claimId = randomUUID();
    const claimed = await this.store.claimEmailInvitationEvent(
      creation.invitation.tenantId,
      creation.idempotencyKey,
      claimId,
      new Date(Date.now() + CREATION_CLAIM_LEASE_MS),
    );
    if (!claimed) {
      this.throwCreationPendingProblem(creation.invitation.id, "event");
    }
    try {
      const storedEvent = this.createInvitationCreatedEvent(claimed.invitation);
      const eventIdentity = storedEvent as unknown as {
        eventId: string;
        timestamp: Date;
      };
      eventIdentity.eventId = claimed.eventId;
      eventIdentity.timestamp = new Date(claimed.eventOccurredAt);
      await this.eventPublisher.publishNow(storedEvent);
      const completed = await this.store.completeEmailInvitationEvent(
        claimed.invitation.tenantId,
        claimed.idempotencyKey,
        claimId,
      );
      if (!completed || completed.eventStatus !== "completed") {
        this.throwCreationPendingProblem(claimed.invitation.id, "event");
      }
      return completed;
    } catch {
      await this.releaseCreationClaimSafely("event", claimed, claimId);
      this.throwCreationPendingProblem(claimed.invitation.id, "event");
    }
  }

  private async deleteExpiredCreationIntentsSafely(): Promise<void> {
    try {
      await this.store.deleteExpiredEmailInvitationCreations(new Date());
    } catch {
      recordEvent("invitation.creation.cleanup_failed");
    }
  }
}
