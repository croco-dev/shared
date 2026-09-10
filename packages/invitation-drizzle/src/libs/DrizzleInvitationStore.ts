import { Component, Inject, Token } from "@croco/framework-context";
import {
  type EmailInvitationCreation,
  type EmailInvitationCreationInput,
  type Invitation,
  type InvitationCreationPhaseStatus,
  InvitationIdempotencyConflictProblem,
  type InvitationStatus,
  InvitationStore,
} from "@croco/invitation-core";
// Runtime value required for constructor metadata.
// oxlint-disable-next-line typescript/consistent-type-imports
import type { TxManager } from "@croco/tx-core";
import type { DrizzleDb } from "@croco/tx-drizzle";
import { and, count, desc, eq, gt, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  INVITATION_TOKEN_CIPHER,
  type InvitationTokenCipher,
  InvitationTokenCipherProblem,
} from "./InvitationTokenCipher";
import { invitationEmailCreationIntents, invitations } from "./schema";

type DrizzleInvitationClient = DrizzleDb & NodePgDatabase<Record<string, never>>;

interface InvitationRow {
  id: string;
  tenantId: string;
  inviterId: string;
  email: string | null;
  tokenHash: string;
  type: "email" | "link";
  role: "owner" | "admin" | "member" | "viewer";
  status: "creating" | "pending" | "accepted" | "expired" | "revoked" | "declined";
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

interface EmailInvitationCreationRow {
  invitationId: string;
  tenantId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  tokenCiphertext: string;
  notificationIdempotencyKey: string;
  notificationStatus: InvitationCreationPhaseStatus;
  notificationClaimId: string | null;
  notificationClaimExpiresAt: Date | null;
  eventStatus: InvitationCreationPhaseStatus;
  eventClaimId: string | null;
  eventClaimExpiresAt: Date | null;
  eventId: string;
  eventOccurredAt: Date;
  createdAt: Date;
}

/**
 * 초대 저장소용 Drizzle 클라이언트 주입 토큰입니다.
 */
export const DRIZZLE_INVITATION_TOKEN = new Token<DrizzleInvitationClient>(
  "DRIZZLE_INVITATION_TOKEN",
);

/**
 * 초대 저장소에서 사용하는 Drizzle 클라이언트 타입입니다.
 */
export type { DrizzleInvitationClient };

/**
 * 초대 엔터티를 Drizzle로 저장하고 조회하는 구현체입니다.
 */
@Component()
export class DrizzleInvitationStore extends InvitationStore {
  private readonly tokenCipher: InvitationTokenCipher;

  /**
   * Drizzle 클라이언트와 트랜잭션 매니저를 받아 저장소를 초기화합니다.
   */
  constructor(
    @Inject(DRIZZLE_INVITATION_TOKEN) private readonly db: DrizzleInvitationClient,
    private readonly txManager: TxManager<DrizzleInvitationClient>,
    @Inject(INVITATION_TOKEN_CIPHER) tokenCipher?: InvitationTokenCipher,
  ) {
    super();
    this.tokenCipher =
      tokenCipher ??
      ({
        encrypt(): never {
          throw new InvitationTokenCipherProblem("configure", "missing");
        },
        decrypt(): never {
          throw new InvitationTokenCipherProblem("configure", "missing");
        },
      } satisfies InvitationTokenCipher);
  }

  /**
   * 초대 ID로 초대를 조회합니다.
   */
  async findById(id: string): Promise<Invitation | null> {
    const client = this.txManager.getClient() ?? this.db;

    const result = (await client
      .select()
      .from(invitations)
      .where(eq(invitations.id, id))
      .limit(1)) as InvitationRow[];
    if (result.length === 0) {
      return null;
    }

    return this.mapToInvitation(result[0]);
  }

  /**
   * 토큰 해시로 초대를 조회합니다.
   */
  async findByTokenHash(tokenHash: string): Promise<Invitation | null> {
    const client = this.txManager.getClient() ?? this.db;

    const result = (await client
      .select()
      .from(invitations)
      .where(eq(invitations.tokenHash, tokenHash))
      .limit(1)) as InvitationRow[];
    if (result.length === 0) {
      return null;
    }

    return this.mapToInvitation(result[0]);
  }

  /**
   * 테넌트와 이메일 조합으로 초대를 조회합니다.
   */
  async findByTenantAndEmail(tenantId: string, email: string): Promise<Invitation | null> {
    const client = this.txManager.getClient() ?? this.db;

    const result = (await client
      .select()
      .from(invitations)
      .where(and(eq(invitations.tenantId, tenantId), eq(invitations.email, email)))
      .orderBy(
        desc(
          sql<number>`case when ${invitations.status} = 'pending' and ${invitations.expiresAt} > statement_timestamp() at time zone 'UTC' then 1 else 0 end`,
        ),
        desc(invitations.createdAt),
        desc(invitations.id),
      )
      .limit(1)) as InvitationRow[];

    if (result.length === 0) {
      return null;
    }

    return this.mapToInvitation(result[0]);
  }

  /**
   * 테넌트의 모든 초대를 조회합니다.
   */
  async findAllByTenant(tenantId: string): Promise<Invitation[]> {
    const client = this.txManager.getClient() ?? this.db;

    const result = (await client
      .select()
      .from(invitations)
      .where(eq(invitations.tenantId, tenantId))) as InvitationRow[];
    return result.map((row) => this.mapToInvitation(row));
  }

  /**
   * 초대를 upsert 방식으로 저장합니다.
   */
  async save(invitation: Invitation): Promise<Invitation> {
    const client = this.txManager.getClient() ?? this.db;

    const result = (await client
      .insert(invitations)
      .values({
        id: invitation.id,
        tenantId: invitation.tenantId,
        inviterId: invitation.inviterId,
        email: invitation.email,
        tokenHash: invitation.tokenHash,
        type: invitation.type,
        role: invitation.role,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
        acceptedAt: invitation.acceptedAt,
        revokedAt: invitation.revokedAt,
        createdAt: invitation.createdAt,
      })
      .onConflictDoUpdate({
        target: [invitations.id],
        set: {
          tenantId: invitation.tenantId,
          inviterId: invitation.inviterId,
          email: invitation.email,
          tokenHash: invitation.tokenHash,
          type: invitation.type,
          role: invitation.role,
          status: invitation.status,
          expiresAt: invitation.expiresAt,
          acceptedAt: invitation.acceptedAt,
          revokedAt: invitation.revokedAt,
          createdAt: invitation.createdAt,
        },
      })
      .returning()) as InvitationRow[];

    return this.mapToInvitation(result[0]);
  }

  async createEmailInvitation(
    input: EmailInvitationCreationInput,
  ): Promise<EmailInvitationCreation> {
    return this.txManager.run(async () => {
      const client = this.txManager.getClient() ?? this.db;
      const existing = await this.findEmailInvitationCreationWithClient(
        client,
        input.invitation.tenantId,
        input.idempotencyKey,
      );

      if (existing) {
        this.assertCreationFingerprint(existing, input);
        if (existing.invitation.expiresAt.getTime() > Date.now()) {
          return existing;
        }
        await client
          .update(invitations)
          .set({ status: "expired" })
          .where(
            and(
              eq(invitations.id, existing.invitation.id),
              eq(invitations.tenantId, existing.invitation.tenantId),
              inArray(invitations.status, ["creating", "pending"]),
            ),
          );
        await client
          .delete(invitationEmailCreationIntents)
          .where(
            and(
              eq(invitationEmailCreationIntents.tenantId, input.invitation.tenantId),
              eq(invitationEmailCreationIntents.idempotencyKey, input.idempotencyKey),
            ),
          );
      }

      const inserted = (await client
        .insert(invitationEmailCreationIntents)
        .values({
          invitationId: input.invitation.id,
          tenantId: input.invitation.tenantId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
          tokenCiphertext: this.tokenCipher.encrypt(input.token, {
            tenantId: input.invitation.tenantId,
            invitationId: input.invitation.id,
            idempotencyKey: input.idempotencyKey,
          }),
          notificationIdempotencyKey: input.notificationIdempotencyKey,
          notificationStatus: input.notificationStatus,
          notificationClaimId: input.notificationClaimId,
          notificationClaimExpiresAt: input.notificationClaimExpiresAt,
          eventStatus: input.eventStatus,
          eventClaimId: input.eventClaimId,
          eventClaimExpiresAt: input.eventClaimExpiresAt,
          eventId: input.eventId,
          eventOccurredAt: input.eventOccurredAt,
          createdAt: input.createdAt,
        })
        .onConflictDoNothing({
          target: [
            invitationEmailCreationIntents.tenantId,
            invitationEmailCreationIntents.idempotencyKey,
          ],
        })
        .returning()) as EmailInvitationCreationRow[];

      if (inserted.length === 0) {
        const concurrent = await this.findEmailInvitationCreationWithClient(
          client,
          input.invitation.tenantId,
          input.idempotencyKey,
        );
        if (!concurrent) {
          throw new InvitationIdempotencyConflictProblem(input.idempotencyKey);
        }
        this.assertCreationFingerprint(concurrent, input);
        return concurrent;
      }

      await this.save(input.invitation);
      return this.mapToEmailInvitationCreation(inserted[0], input.invitation);
    });
  }

  async claimEmailInvitationNotification(
    tenantId: string,
    idempotencyKey: string,
    claimId: string,
    claimExpiresAt: Date,
  ): Promise<EmailInvitationCreation | null> {
    return this.claimEmailInvitationCreationPhase(
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
    return this.claimEmailInvitationCreationPhase(
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
    return this.completeEmailInvitationCreationPhase(
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
    return this.completeEmailInvitationCreationPhase(
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
    await this.releaseEmailInvitationCreationPhase(
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
    await this.releaseEmailInvitationCreationPhase(
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
    return this.txManager.run(async () => {
      const client = this.txManager.getClient() ?? this.db;
      const creation = await this.findEmailInvitationCreationWithClient(
        client,
        tenantId,
        idempotencyKey,
      );
      if (
        !creation ||
        creation.notificationStatus !== "completed" ||
        creation.eventStatus !== "completed"
      ) {
        return creation;
      }

      await client
        .update(invitations)
        .set({ status: "pending" })
        .where(
          and(
            eq(invitations.id, creation.invitation.id),
            eq(invitations.tenantId, tenantId),
            eq(invitations.status, "creating"),
          ),
        );
      return this.findEmailInvitationCreationWithClient(client, tenantId, idempotencyKey);
    });
  }

  async deleteExpiredEmailInvitationCreations(now: Date): Promise<number> {
    return this.txManager.run(async () => {
      const client = this.txManager.getClient() ?? this.db;
      const expiredInvitationIds = client
        .select({ id: invitations.id })
        .from(invitations)
        .where(lte(invitations.expiresAt, now));
      await client
        .update(invitations)
        .set({ status: "expired" })
        .where(
          and(
            inArray(invitations.id, expiredInvitationIds),
            inArray(invitations.status, ["creating", "pending"]),
          ),
        );
      const deleted = (await client
        .delete(invitationEmailCreationIntents)
        .where(inArray(invitationEmailCreationIntents.invitationId, expiredInvitationIds))
        .returning({
          invitationId: invitationEmailCreationIntents.invitationId,
        })) as Array<{
        invitationId: string;
      }>;
      return deleted.length;
    });
  }

  async findEmailInvitationCreation(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<EmailInvitationCreation | null> {
    const client = this.txManager.getClient() ?? this.db;
    return this.findEmailInvitationCreationWithClient(client, tenantId, idempotencyKey);
  }

  /**
   * 초대 상태를 변경하고 변경된 초대를 반환합니다.
   */
  async updateStatus(
    tenantId: string,
    id: string,
    status: InvitationStatus,
  ): Promise<Invitation | null> {
    const client = this.txManager.getClient() ?? this.db;
    const whereClause =
      status === "accepted"
        ? and(
            eq(invitations.tenantId, tenantId),
            eq(invitations.id, id),
            eq(invitations.status, "pending"),
          )
        : and(eq(invitations.tenantId, tenantId), eq(invitations.id, id));

    const result = (await client
      .update(invitations)
      .set({ status })
      .where(whereClause)
      .returning()) as InvitationRow[];

    if (result.length === 0) {
      return null;
    }

    return this.mapToInvitation(result[0]);
  }

  async compareAndSetStatus(
    tenantId: string,
    id: string,
    expected: InvitationStatus,
    desired: InvitationStatus,
    meta: { acceptedAt?: Date; rejectedAt?: Date } = {},
  ): Promise<Invitation | null> {
    if (desired === "accepted") {
      return this.txManager.run(async () => {
        const client = this.txManager.getClient() ?? this.db;
        const locked = await client
          .select({ id: invitations.id })
          .from(invitations)
          .where(
            and(
              eq(invitations.tenantId, tenantId),
              eq(invitations.id, id),
              eq(invitations.status, expected),
            ),
          )
          .for("update");
        if (locked.length === 0) {
          return null;
        }

        const databaseAcceptedAt = sql<Date>`statement_timestamp() AT TIME ZONE 'UTC'`;
        const acceptedAt = meta.acceptedAt
          ? sql<Date>`greatest(${meta.acceptedAt.toISOString()}::timestamptz AT TIME ZONE 'UTC', ${databaseAcceptedAt})`
          : databaseAcceptedAt;
        const result = (await client
          .update(invitations)
          .set({
            status: desired,
            acceptedAt,
          })
          .where(
            and(
              eq(invitations.tenantId, tenantId),
              eq(invitations.id, id),
              eq(invitations.status, expected),
              gt(invitations.expiresAt, acceptedAt),
            ),
          )
          .returning()) as InvitationRow[];

        if (result.length === 0) {
          return null;
        }

        return this.mapToInvitation(result[0]);
      });
    }

    const client = this.txManager.getClient() ?? this.db;
    const result = (await client
      .update(invitations)
      .set({
        status: desired,
        acceptedAt: meta.acceptedAt,
      })
      .where(
        and(
          eq(invitations.tenantId, tenantId),
          eq(invitations.id, id),
          eq(invitations.status, expected),
        ),
      )
      .returning()) as InvitationRow[];

    if (result.length === 0) {
      return null;
    }

    return this.mapToInvitation(result[0]);
  }

  /**
   * 일정 시점 이후 생성된 모든 상태의 초대 수를 반환합니다.
   */
  async countIssuedByTenant(tenantId: string, since: Date): Promise<number> {
    const client = this.txManager.getClient() ?? this.db;

    const result = (await client
      .select({ total: count() })
      .from(invitations)
      .where(and(eq(invitations.tenantId, tenantId), gte(invitations.createdAt, since)))) as {
      total: number;
    }[];

    return Number(result[0].total);
  }

  /**
   * 일정 시점 이후 생성된 대기 중 초대 수를 반환합니다.
   */
  async countPendingByTenant(tenantId: string, since: Date): Promise<number> {
    const client = this.txManager.getClient() ?? this.db;

    const result = (await client
      .select({ total: count() })
      .from(invitations)
      .where(
        and(
          eq(invitations.tenantId, tenantId),
          eq(invitations.status, "pending"),
          gte(invitations.createdAt, since),
        ),
      )) as { total: number }[];

    return Number(result[0]?.total ?? 0);
  }

  private mapToInvitation(row: InvitationRow): Invitation {
    return {
      id: row.id,
      tenantId: row.tenantId,
      inviterId: row.inviterId,
      email: row.email,
      tokenHash: row.tokenHash,
      type: row.type,
      role: row.role,
      status: row.status,
      expiresAt: row.expiresAt,
      acceptedAt: row.acceptedAt,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt,
    };
  }

  private async findEmailInvitationCreationWithClient(
    client: DrizzleInvitationClient,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<EmailInvitationCreation | null> {
    const rows = (await client
      .select()
      .from(invitationEmailCreationIntents)
      .where(
        and(
          eq(invitationEmailCreationIntents.tenantId, tenantId),
          eq(invitationEmailCreationIntents.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1)) as EmailInvitationCreationRow[];
    const row = rows[0];
    if (!row) {
      return null;
    }

    const invitation = await this.findById(row.invitationId);
    return invitation ? this.mapToEmailInvitationCreation(row, invitation) : null;
  }

  private async completeEmailInvitationCreationPhase(
    tenantId: string,
    idempotencyKey: string,
    phase: "notificationStatus" | "eventStatus",
    claimField: "notificationClaimId" | "eventClaimId",
    expiryField: "notificationClaimExpiresAt" | "eventClaimExpiresAt",
    claimId: string,
  ): Promise<EmailInvitationCreation | null> {
    const client = this.txManager.getClient() ?? this.db;
    const column =
      phase === "notificationStatus"
        ? invitationEmailCreationIntents.notificationStatus
        : invitationEmailCreationIntents.eventStatus;
    const rows = (await client
      .update(invitationEmailCreationIntents)
      .set({
        [phase]: "completed",
        [claimField]: null,
        [expiryField]: null,
      })
      .where(
        and(
          eq(invitationEmailCreationIntents.tenantId, tenantId),
          eq(invitationEmailCreationIntents.idempotencyKey, idempotencyKey),
          eq(column, "processing"),
          eq(invitationEmailCreationIntents[claimField], claimId),
        ),
      )
      .returning()) as EmailInvitationCreationRow[];

    const row = rows[0];
    if (!row) {
      return null;
    }

    const invitation = await this.findById(row.invitationId);
    return invitation ? this.mapToEmailInvitationCreation(row, invitation) : null;
  }

  private async claimEmailInvitationCreationPhase(
    tenantId: string,
    idempotencyKey: string,
    phase: "notificationStatus" | "eventStatus",
    claimField: "notificationClaimId" | "eventClaimId",
    expiryField: "notificationClaimExpiresAt" | "eventClaimExpiresAt",
    claimId: string,
    claimExpiresAt: Date,
  ): Promise<EmailInvitationCreation | null> {
    const client = this.txManager.getClient() ?? this.db;
    const statusColumn = invitationEmailCreationIntents[phase];
    const expiryColumn = invitationEmailCreationIntents[expiryField];
    const rows = (await client
      .update(invitationEmailCreationIntents)
      .set({
        [phase]: "processing",
        [claimField]: claimId,
        [expiryField]: claimExpiresAt,
      })
      .where(
        and(
          eq(invitationEmailCreationIntents.tenantId, tenantId),
          eq(invitationEmailCreationIntents.idempotencyKey, idempotencyKey),
          or(
            eq(statusColumn, "pending"),
            and(
              eq(statusColumn, "processing"),
              or(isNull(expiryColumn), lte(expiryColumn, new Date())),
            ),
          ),
        ),
      )
      .returning()) as EmailInvitationCreationRow[];
    const row = rows[0];
    if (!row) {
      return null;
    }
    const invitation = await this.findById(row.invitationId);
    return invitation ? this.mapToEmailInvitationCreation(row, invitation) : null;
  }

  private async releaseEmailInvitationCreationPhase(
    tenantId: string,
    idempotencyKey: string,
    phase: "notificationStatus" | "eventStatus",
    claimField: "notificationClaimId" | "eventClaimId",
    expiryField: "notificationClaimExpiresAt" | "eventClaimExpiresAt",
    claimId: string,
  ): Promise<void> {
    const client = this.txManager.getClient() ?? this.db;
    await client
      .update(invitationEmailCreationIntents)
      .set({
        [phase]: "pending",
        [claimField]: null,
        [expiryField]: null,
      })
      .where(
        and(
          eq(invitationEmailCreationIntents.tenantId, tenantId),
          eq(invitationEmailCreationIntents.idempotencyKey, idempotencyKey),
          eq(invitationEmailCreationIntents[phase], "processing"),
          eq(invitationEmailCreationIntents[claimField], claimId),
        ),
      );
  }

  private mapToEmailInvitationCreation(
    row: EmailInvitationCreationRow,
    invitation: Invitation,
  ): EmailInvitationCreation {
    return {
      invitation,
      token: this.tokenCipher.decrypt(row.tokenCiphertext, {
        tenantId: row.tenantId,
        invitationId: row.invitationId,
        idempotencyKey: row.idempotencyKey,
      }),
      idempotencyKey: row.idempotencyKey,
      requestFingerprint: row.requestFingerprint,
      notificationIdempotencyKey: row.notificationIdempotencyKey,
      notificationStatus: row.notificationStatus,
      notificationClaimId: row.notificationClaimId,
      notificationClaimExpiresAt: row.notificationClaimExpiresAt,
      eventStatus: row.eventStatus,
      eventClaimId: row.eventClaimId,
      eventClaimExpiresAt: row.eventClaimExpiresAt,
      eventId: row.eventId,
      eventOccurredAt: row.eventOccurredAt,
      createdAt: row.createdAt,
    };
  }

  private assertCreationFingerprint(
    existing: EmailInvitationCreation,
    input: EmailInvitationCreationInput,
  ): void {
    if (existing.requestFingerprint !== input.requestFingerprint) {
      throw new InvitationIdempotencyConflictProblem(input.idempotencyKey);
    }
  }
}
