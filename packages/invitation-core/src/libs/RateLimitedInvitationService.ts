// Constructor dependencies must remain runtime values for emitted design:paramtypes metadata.
/* oxlint-disable typescript/consistent-type-imports */
import { randomUUID } from "node:crypto";
import { Component } from "@croco/framework-context";
import type { MembershipRole } from "@croco/membership-core";
import { InvitationManager } from "./InvitationManager";
import { InvitationStore } from "./InvitationStore";
import { BatchSizeExceededProblem } from "./problems/BatchInviteProblems";
import {
  DuplicateInvitationProblem,
  InvitationRateLimitExceededProblem,
} from "./problems/RateLimitProblems";
import type { BatchInviteOptions, BatchInviteResult, RateLimitConfig } from "./types";

type CreateEmailInvitationInput = {
  idempotencyKey: string;
  tenantId: string;
  inviterId: string;
  email: string;
  role: MembershipRole;
  expiresInDays?: number;
};

type CreateLinkInvitationInput = {
  idempotencyKey: string;
  tenantId: string;
  inviterId: string;
  role: MembershipRole;
  expiresInDays?: number;
};

@Component()
export class RateLimitedInvitationService {
  private readonly DEFAULT_CONFIG: RateLimitConfig = {
    maxInvitesPerHour: 100,
    maxInvitesPerDay: 1000,
  };

  constructor(
    private readonly manager: InvitationManager,
    private readonly store: InvitationStore,
    private readonly config: RateLimitConfig | undefined = undefined,
  ) {}

  async checkRateLimit(tenantId: string): Promise<void> {
    const config = this.config ?? this.DEFAULT_CONFIG;

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const hourlyCount = await this.store.countIssuedByTenant(tenantId, oneHourAgo);
    const dailyCount = await this.store.countIssuedByTenant(tenantId, oneDayAgo);

    if (hourlyCount >= config.maxInvitesPerHour) {
      throw new InvitationRateLimitExceededProblem(`${config.maxInvitesPerHour} per hour`);
    }

    if (dailyCount >= config.maxInvitesPerDay) {
      throw new InvitationRateLimitExceededProblem(`${config.maxInvitesPerDay} per day`);
    }
  }

  async createEmailInvitationWithRateLimit(input: CreateEmailInvitationInput): Promise<string> {
    const replay = await this.store.findEmailInvitationCreation(
      input.tenantId,
      input.idempotencyKey,
    );
    if (replay) {
      return this.manager.createEmailInvitation(input);
    }

    await this.checkRateLimit(input.tenantId);

    const normalizedEmail = input.email.trim().toLowerCase();
    const existing = await this.store.findByTenantAndEmail(input.tenantId, normalizedEmail);

    if (existing && existing.status === "pending" && existing.expiresAt.getTime() > Date.now()) {
      throw new DuplicateInvitationProblem(input.tenantId, normalizedEmail);
    }

    return this.manager.createEmailInvitation({
      ...input,
      email: normalizedEmail,
    });
  }

  async createLinkInvitationWithRateLimit(input: CreateLinkInvitationInput): Promise<string> {
    const replay = await this.store.findEmailInvitationCreation(
      input.tenantId,
      input.idempotencyKey,
    );
    if (replay) {
      return this.manager.createLinkInvitation(input);
    }

    await this.checkRateLimit(input.tenantId);

    return this.manager.createLinkInvitation(input);
  }

  async batchInvite(
    tenantId: string,
    emails: string[],
    options: BatchInviteOptions = {},
  ): Promise<BatchInviteResult> {
    const maxBatchSize = options.maxBatchSize ?? 50;

    if (emails.length > maxBatchSize) {
      throw new BatchSizeExceededProblem(maxBatchSize);
    }

    const result: BatchInviteResult = {
      successful: [],
      failed: [],
    };

    for (const email of emails) {
      try {
        await this.checkRateLimit(tenantId);

        const normalizedEmail = email.trim().toLowerCase();
        const idempotencyKey = `${options.idempotencyKey ?? randomUUID()}:${normalizedEmail}`;
        const replay = await this.store.findEmailInvitationCreation(tenantId, idempotencyKey);
        if (replay) {
          const token = await this.manager.createEmailInvitation({
            idempotencyKey,
            tenantId,
            inviterId: "system",
            email: normalizedEmail,
            role: "member" as const,
            expiresInDays: options.expiresInDays,
          });
          result.successful.push({ email: normalizedEmail, token });
          continue;
        }
        const existing = await this.store.findByTenantAndEmail(tenantId, normalizedEmail);

        if (existing && existing.status === "pending") {
          result.failed.push({
            email: normalizedEmail,
            error: "Invitation already pending",
          });
          continue;
        }

        const token = await this.manager.createEmailInvitation({
          idempotencyKey,
          tenantId,
          inviterId: "system",
          email: normalizedEmail,
          role: "member" as const,
          expiresInDays: options.expiresInDays,
        });

        result.successful.push({
          email: normalizedEmail,
          token,
        });
      } catch (error) {
        result.failed.push({
          email: email.trim().toLowerCase(),
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    return result;
  }
}
