import "reflect-metadata";
import { inspect } from "node:util";
import type { EventPublisher } from "@croco/events-core";
import type { Membership, MembershipManager } from "@croco/membership-core";
import {
  createNotificationIdempotencyKey,
  NotificationChannel,
  type NotificationService,
} from "@croco/notifications-core";
import { Problem, ProblemCategory } from "@croco/problems-core";
import { TxManager, type TxAdapter } from "@croco/tx-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  InvitationAcceptedEvent,
  InvitationCreatedEvent,
  InvitationDeclinedEvent,
  InvitationRevokedEvent,
} from "../libs/events/InvitationEvents";
import { InMemoryInvitationStore } from "../libs/InMemoryInvitationStore";
import { InvitationManager } from "../libs/InvitationManager";
import {
  InvalidInvitationExpiryDurationProblem,
  InvitationAlreadyAcceptedProblem,
  InvitationCreationFailedProblem,
  InvitationEmailMismatchProblem,
  InvitationExpiredProblem,
  InvitationIdempotencyConflictProblem,
  InvitationInvalidStatusProblem,
  InvitationNotFoundProblem,
} from "../libs/problems/InvitationProblems";
import { hashToken } from "../libs/token";
import type { Invitation } from "../libs/types";

class NonRetryablePersistenceProblem extends Problem {
  constructor() {
    super(
      "invitation-test/non-retryable-persistence",
      ProblemCategory.InternalServerError,
      "Persistence is not configured",
      { extensions: { retryable: false } },
    );
  }
}

describe("InvitationManager", () => {
  const invalidExpiryDurations = [
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["negative", -1],
    ["zero", 0],
    ["fractional", 0.5],
    ["date-overflowing", Number.MAX_SAFE_INTEGER],
  ] as const;

  let manager!: InvitationManager;
  let store!: InMemoryInvitationStore;
  let publishNow!: ReturnType<typeof vi.fn>;
  let addMember!: ReturnType<typeof vi.fn>;
  let send!: ReturnType<typeof vi.fn>;
  let txManager!: TxManager<unknown>;
  let sequence = 0;

  const createInvitation = (token: string, overrides: Partial<Invitation> = {}): Invitation => {
    sequence += 1;
    const now = new Date();
    const defaultExpiresAt = new Date(now);
    defaultExpiresAt.setDate(defaultExpiresAt.getDate() + 7);

    return {
      id: overrides.id ?? `inv-${sequence}`,
      tenantId: overrides.tenantId ?? "tenant-1",
      inviterId: overrides.inviterId ?? "inviter-1",
      email: overrides.email ?? "member@croco.dev",
      tokenHash: overrides.tokenHash ?? hashToken(token),
      type: overrides.type ?? "email",
      role: overrides.role ?? "member",
      status: overrides.status ?? "pending",
      expiresAt: overrides.expiresAt ?? defaultExpiresAt,
      acceptedAt: overrides.acceptedAt ?? null,
      revokedAt: overrides.revokedAt ?? null,
      createdAt: overrides.createdAt ?? now,
    };
  };

  beforeEach(() => {
    store = new InMemoryInvitationStore();
    publishNow = vi.fn();
    addMember = vi.fn();
    send = vi.fn();
    const txAdapter: TxAdapter<unknown> = {
      async transaction<T>(fn: (client: unknown) => Promise<T>): Promise<T> {
        return fn({});
      },
      async savepoint<T>(_client: unknown, fn: (client: unknown) => Promise<T>): Promise<T> {
        return fn({});
      },
      supportsSavepoint: () => false,
    };
    txManager = new TxManager(txAdapter);
    sequence = 0;

    manager = new InvitationManager(
      store,
      { addMember } as unknown as MembershipManager,
      { send } as unknown as NotificationService,
      {
        publishNow,
        publishMany: vi.fn(),
      } as unknown as EventPublisher,
      txManager,
    );
  });

  it("should create email invitation with hashed token and send notification", async () => {
    const token = await manager.createEmailInvitation({
      idempotencyKey: "create-member-1",
      tenantId: "tenant-1",
      inviterId: "inviter-1",
      email: "Member@Croco.Dev",
      role: "member",
    });

    const invitation = await store.findByTenantAndEmail("tenant-1", "member@croco.dev");

    expect(invitation).not.toBeNull();
    if (invitation === null) {
      throw new Error("Invitation was not created");
    }

    const preferenceContext = {
      tenantId: "tenant-1",
      userId: "member@croco.dev",
      channel: NotificationChannel.EMAIL,
      topic: "invitation.created",
    };

    expect(invitation?.tokenHash).toBe(hashToken(token));
    expect(invitation?.tokenHash).not.toBe(token);
    expect(send).toHaveBeenCalledWith(
      NotificationChannel.EMAIL,
      expect.objectContaining({
        to: "member@croco.dev",
      }),
      {
        idempotencyKey: createNotificationIdempotencyKey({
          ...preferenceContext,
          recipient: "member@croco.dev",
          semanticKey: "create-member-1",
        }),
        preferenceContext,
        requireProviderIdempotency: true,
      },
    );
    expect(publishNow).toHaveBeenCalledWith(expect.any(InvitationCreatedEvent));
  });

  it("should retry the durable event intent without sending the notification again", async () => {
    send.mockResolvedValue(undefined);
    publishNow.mockRejectedValueOnce(new Error("publish failed"));

    const input = {
      idempotencyKey: "event-failure-1",
      tenantId: "tenant-1",
      inviterId: "inviter-1",
      email: "member@croco.dev",
      role: "member" as const,
    };

    await expect(manager.createEmailInvitation(input)).rejects.toMatchObject({
      extensions: { phase: "event", retrySafe: true },
    });
    const token = await manager.createEmailInvitation(input);

    const invitation = await store.findByTokenHash(hashToken(token));
    expect(invitation?.status).toBe("pending");
    expect(send).toHaveBeenCalledTimes(1);
    expect(publishNow).toHaveBeenCalledTimes(2);
    const firstEvent = publishNow.mock.calls[0]?.[0] as InvitationCreatedEvent;
    const secondEvent = publishNow.mock.calls[1]?.[0] as InvitationCreatedEvent;
    expect(secondEvent.eventId).toBe(firstEvent.eventId);
  });

  it("should stop before notification when a stale event owner cannot complete its claim", async () => {
    vi.spyOn(store, "completeEmailInvitationEvent").mockResolvedValueOnce(null);

    await expect(
      manager.createEmailInvitation({
        idempotencyKey: "stale-event-owner-1",
        tenantId: "tenant-1",
        inviterId: "inviter-1",
        email: "member@croco.dev",
        role: "member",
      }),
    ).rejects.toMatchObject({
      extensions: { phase: "event", retrySafe: true },
    });

    expect(publishNow).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect((await store.findAllByTenant("tenant-1"))[0]?.status).toBe("creating");
  });

  it("should keep a retryable delivery intent without exposing the token in its Problem", async () => {
    send.mockImplementationOnce(async (_channel, payload) => {
      throw new Error(`delivery failed for ${payload.content}`);
    });

    const result = manager.createEmailInvitation({
      idempotencyKey: "notification-failure-1",
      tenantId: "tenant-1",
      inviterId: "inviter-1",
      email: "member@croco.dev",
      role: "member",
    });

    const error = await result.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(InvitationCreationFailedProblem);

    const invitations = await store.findAllByTenant("tenant-1");
    expect(invitations).toHaveLength(1);
    expect(invitations[0]?.status).toBe("creating");
    expect(JSON.stringify(error)).not.toContain("Use this invitation token");
    expect(inspect(error)).not.toContain("Use this invitation token");
    expect(error).toMatchObject({
      cause: undefined,
      code: "INVITATION_CREATION_FAILED",
      extensions: {
        phase: "notification",
        retrySafe: true,
      },
    });
  });

  it("should replay the same token and notification key when delivery acknowledgement is lost", async () => {
    let firstContent = "";
    send
      .mockImplementationOnce(async (_channel, payload) => {
        firstContent = payload.content;
        const deliveredToken = payload.content.replace("Use this invitation token: ", "");
        await expect(
          manager.acceptInvitation({
            token: deliveredToken,
            userId: "recipient-1",
            email: "member@croco.dev",
          }),
        ).rejects.toBeInstanceOf(InvitationInvalidStatusProblem);
        throw new Error("delivery acknowledgement lost");
      })
      .mockResolvedValue(undefined);

    const input = {
      idempotencyKey: "retry-member-1",
      tenantId: "tenant-1",
      inviterId: "inviter-1",
      email: "member@croco.dev",
      role: "member" as const,
    };

    await expect(manager.createEmailInvitation(input)).rejects.toBeInstanceOf(
      InvitationCreationFailedProblem,
    );
    const token = await manager.createEmailInvitation(input);

    const invitations = await store.findAllByTenant("tenant-1");
    expect(invitations).toHaveLength(1);
    expect(invitations[0]?.tokenHash).toBe(hashToken(token));
    expect(invitations[0]?.status).toBe("pending");
    expect(send).toHaveBeenCalledTimes(2);
    expect(firstContent).toContain(token);
    expect(send.mock.calls[1]?.[1].content).toBe(firstContent);
    expect(send.mock.calls[1]?.[2].idempotencyKey).toBe(send.mock.calls[0]?.[2].idempotencyKey);
    expect(addMember).not.toHaveBeenCalled();
  });

  it("should replay a completed creation after a successful response is lost", async () => {
    const input = {
      idempotencyKey: "successful-response-lost-1",
      tenantId: "tenant-1",
      inviterId: "inviter-1",
      email: "member@croco.dev",
      role: "member" as const,
    };

    const firstToken = await manager.createEmailInvitation(input);
    const replayedToken = await manager.createEmailInvitation(input);

    expect(replayedToken).toBe(firstToken);
    expect(await store.findAllByTenant("tenant-1")).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(publishNow).toHaveBeenCalledTimes(1);
  });

  it("should claim concurrent delivery so only one caller executes side effects", async () => {
    let releaseDelivery!: () => void;
    const delivery = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    send.mockImplementation(() => delivery);
    const input = {
      idempotencyKey: "concurrent-create-1",
      tenantId: "tenant-1",
      inviterId: "inviter-1",
      email: "member@croco.dev",
      role: "member" as const,
    };

    const firstRequest = manager.createEmailInvitation(input);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const secondRequest = manager.createEmailInvitation(input);
    await expect(secondRequest).rejects.toMatchObject({
      extensions: { phase: "notification", retrySafe: true },
    });
    releaseDelivery();
    const firstToken = await firstRequest;

    expect(firstToken).toBeTypeOf("string");
    expect(await store.findAllByTenant("tenant-1")).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    const eventIds = publishNow.mock.calls.map(
      ([event]) => (event as InvitationCreatedEvent).eventId,
    );
    expect(new Set(eventIds)).toEqual(new Set([eventIds[0]]));
  });

  it("should recover an atomically persisted creation after its acknowledgement is lost", async () => {
    const create = store.createEmailInvitation.bind(store);
    vi.spyOn(store, "createEmailInvitation")
      .mockImplementationOnce(async (input) => {
        await create(input);
        throw new Error("commit acknowledgement lost");
      })
      .mockImplementation(create);
    const input = {
      idempotencyKey: "persistence-ack-lost-1",
      tenantId: "tenant-1",
      inviterId: "inviter-1",
      email: "member@croco.dev",
      role: "member" as const,
    };

    await expect(manager.createEmailInvitation(input)).rejects.toMatchObject({
      cause: undefined,
      extensions: { phase: "persistence", retrySafe: true },
    });
    const token = await manager.createEmailInvitation(input);

    expect(await store.findAllByTenant("tenant-1")).toHaveLength(1);
    expect(await store.findByTokenHash(hashToken(token))).not.toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("should atomically retire an expired replay even when best-effort cleanup fails", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const input = {
        idempotencyKey: "expired-replay-1",
        tenantId: "tenant-1",
        inviterId: "inviter-1",
        email: "member@croco.dev",
        role: "member" as const,
        expiresInDays: 1,
      };
      const firstToken = await manager.createEmailInvitation(input);
      const firstInvitation = await store.findByTokenHash(hashToken(firstToken));

      vi.setSystemTime(new Date("2026-01-03T00:00:00.000Z"));
      vi.spyOn(store, "deleteExpiredEmailInvitationCreations").mockRejectedValueOnce(
        new Error("cleanup unavailable"),
      );
      const replacementToken = await manager.createEmailInvitation(input);

      expect(replacementToken).not.toBe(firstToken);
      expect((await store.findById(firstInvitation?.id ?? ""))?.status).toBe("expired");
      expect((await store.findByTokenHash(hashToken(replacementToken)))?.status).toBe("pending");
    } finally {
      vi.useRealTimers();
    }
  });

  it("should reject reuse of an idempotency key for different invitation input", async () => {
    await manager.createEmailInvitation({
      idempotencyKey: "conflicting-request-1",
      tenantId: "tenant-1",
      inviterId: "inviter-1",
      email: "first@croco.dev",
      role: "member",
    });

    await expect(
      manager.createEmailInvitation({
        idempotencyKey: "conflicting-request-1",
        tenantId: "tenant-1",
        inviterId: "inviter-1",
        email: "second@croco.dev",
        role: "member",
      }),
    ).rejects.toBeInstanceOf(InvitationIdempotencyConflictProblem);
    expect(await store.findAllByTenant("tenant-1")).toHaveLength(1);
  });

  it("should create link invitation without sending notification", async () => {
    const token = await manager.createLinkInvitation({
      idempotencyKey: "create-link-1",
      tenantId: "tenant-1",
      inviterId: "inviter-1",
      role: "member",
    });

    const invitation = await store.findByTokenHash(hashToken(token));

    expect(invitation).not.toBeNull();
    expect(invitation?.type).toBe("link");
    expect(invitation?.email).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("should retry a link event intent with the original token and event identity", async () => {
    publishNow.mockRejectedValueOnce(new Error("publish failed"));
    const input = {
      idempotencyKey: "link-event-failure-1",
      tenantId: "tenant-1",
      inviterId: "inviter-1",
      role: "member" as const,
    };

    await expect(manager.createLinkInvitation(input)).rejects.toMatchObject({
      extensions: { phase: "event", retrySafe: true },
    });
    const token = await manager.createLinkInvitation(input);

    expect(await store.findAllByTenant("tenant-1")).toHaveLength(1);
    expect((await store.findByTokenHash(hashToken(token)))?.status).toBe("pending");
    expect(send).not.toHaveBeenCalled();
    expect(publishNow).toHaveBeenCalledTimes(2);
    const firstEvent = publishNow.mock.calls[0]?.[0] as InvitationCreatedEvent;
    const secondEvent = publishNow.mock.calls[1]?.[0] as InvitationCreatedEvent;
    expect(secondEvent.eventId).toBe(firstEvent.eventId);
  });

  it("should replay a completed link creation without creating another invitation", async () => {
    const input = {
      idempotencyKey: "link-response-lost-1",
      tenantId: "tenant-1",
      inviterId: "inviter-1",
      role: "member" as const,
    };

    const firstToken = await manager.createLinkInvitation(input);
    const replayedToken = await manager.createLinkInvitation(input);

    expect(replayedToken).toBe(firstToken);
    expect(await store.findAllByTenant("tenant-1")).toHaveLength(1);
    expect(publishNow).toHaveBeenCalledTimes(1);
  });

  it("should fence concurrent link retries to one stable event identity", async () => {
    let releasePublication!: () => void;
    const publication = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    publishNow.mockImplementation(() => publication);
    const input = {
      idempotencyKey: "concurrent-link-1",
      tenantId: "tenant-1",
      inviterId: "inviter-1",
      role: "member" as const,
    };

    const firstRequest = manager.createLinkInvitation(input);
    await vi.waitFor(() => expect(publishNow).toHaveBeenCalledTimes(1));
    const secondRequest = manager.createLinkInvitation(input);
    await expect(secondRequest).rejects.toMatchObject({
      extensions: { phase: "event", retrySafe: true },
    });
    releasePublication();
    await expect(firstRequest).resolves.toBeTypeOf("string");

    expect(await store.findAllByTenant("tenant-1")).toHaveLength(1);
    expect(publishNow).toHaveBeenCalledTimes(1);
  });

  it("should reject conflicting link input under the same idempotency key", async () => {
    await manager.createLinkInvitation({
      idempotencyKey: "conflicting-link-1",
      tenantId: "tenant-1",
      inviterId: "inviter-1",
      role: "member",
    });

    await expect(
      manager.createLinkInvitation({
        idempotencyKey: "conflicting-link-1",
        tenantId: "tenant-1",
        inviterId: "inviter-1",
        role: "admin",
      }),
    ).rejects.toBeInstanceOf(InvitationIdempotencyConflictProblem);
    expect(await store.findAllByTenant("tenant-1")).toHaveLength(1);
  });

  it("should reject an email and link command sharing one idempotency key", async () => {
    await manager.createEmailInvitation({
      idempotencyKey: "cross-type-conflict-1",
      tenantId: "tenant-1",
      inviterId: "inviter-1",
      email: "member@croco.dev",
      role: "member",
    });

    await expect(
      manager.createLinkInvitation({
        idempotencyKey: "cross-type-conflict-1",
        tenantId: "tenant-1",
        inviterId: "inviter-1",
        role: "member",
      }),
    ).rejects.toBeInstanceOf(InvitationIdempotencyConflictProblem);
  });

  it("should preserve a non-retryable persistence Problem during link creation", async () => {
    const problem = new NonRetryablePersistenceProblem();
    vi.spyOn(store, "createEmailInvitation").mockRejectedValueOnce(problem);

    await expect(
      manager.createLinkInvitation({
        idempotencyKey: "link-persistence-config-1",
        tenantId: "tenant-1",
        inviterId: "inviter-1",
        role: "member",
      }),
    ).rejects.toBe(problem);
  });

  it("should preserve a non-retryable activation Problem during link creation", async () => {
    const problem = new NonRetryablePersistenceProblem();
    vi.spyOn(store, "activateEmailInvitation").mockRejectedValueOnce(problem);

    await expect(
      manager.createLinkInvitation({
        idempotencyKey: "link-activation-config-1",
        tenantId: "tenant-1",
        inviterId: "inviter-1",
        role: "member",
      }),
    ).rejects.toBe(problem);
  });

  it.each(invalidExpiryDurations)(
    "should reject %s email expiry without persistence, notification, or event side effects",
    async (_label, expiresInDays) => {
      const save = vi.spyOn(store, "save");
      const deleteExpiredCreations = vi.spyOn(store, "deleteExpiredEmailInvitationCreations");

      await expect(
        manager.createEmailInvitation({
          idempotencyKey: `invalid-expiry-${_label}`,
          tenantId: "tenant-1",
          inviterId: "inviter-1",
          email: "member@croco.dev",
          role: "member",
          expiresInDays,
        }),
      ).rejects.toBeInstanceOf(InvalidInvitationExpiryDurationProblem);

      expect(save).not.toHaveBeenCalled();
      expect(deleteExpiredCreations).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(publishNow).not.toHaveBeenCalled();
    },
  );

  it.each(invalidExpiryDurations)(
    "should reject %s link expiry without persistence or event side effects",
    async (_label, expiresInDays) => {
      const save = vi.spyOn(store, "save");

      await expect(
        manager.createLinkInvitation({
          idempotencyKey: `invalid-link-expiry-${_label}`,
          tenantId: "tenant-1",
          inviterId: "inviter-1",
          role: "member",
          expiresInDays,
        }),
      ).rejects.toBeInstanceOf(InvalidInvitationExpiryDurationProblem);

      expect(save).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(publishNow).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["email", 1],
    ["link", 1],
  ] as const)(
    "should persist a serializable finite expiry for a valid %s duration",
    async (type, expiresInDays) => {
      const token =
        type === "email"
          ? await manager.createEmailInvitation({
              idempotencyKey: "finite-expiry-email",
              tenantId: "tenant-1",
              inviterId: "inviter-1",
              email: "member@croco.dev",
              role: "member",
              expiresInDays,
            })
          : await manager.createLinkInvitation({
              idempotencyKey: "finite-expiry-link",
              tenantId: "tenant-1",
              inviterId: "inviter-1",
              role: "member",
              expiresInDays,
            });

      const invitation = await store.findByTokenHash(hashToken(token));

      expect(invitation).not.toBeNull();
      expect(Number.isFinite(invitation?.expiresAt.getTime())).toBe(true);
      expect(JSON.stringify({ expiresAt: invitation?.expiresAt })).toMatch(
        /^\{"expiresAt":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"\}$/,
      );
    },
  );

  it("should accept email invitation and create membership", async () => {
    await store.save(createInvitation("accept-email-token"));

    const membership: Membership = {
      id: "mem-1",
      tenantId: "tenant-1",
      userId: "user-1",
      role: "member",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    addMember.mockResolvedValue(membership);

    const accepted = await manager.acceptInvitation({
      token: "accept-email-token",
      userId: "user-1",
      email: "MEMBER@CROCO.DEV",
    });

    expect(addMember).toHaveBeenCalledWith(
      "tenant-1",
      "user-1",
      "member",
      "invitation-accept:inv-1:user-1",
    );
    expect(accepted.status).toBe("committed");
    expect(accepted.value.status).toBe("accepted");
    expect(accepted.value.acceptedAt).not.toBeNull();
    expect(accepted.afterCommit).toEqual({ status: "succeeded", hookCount: 1 });
    expect(publishNow).toHaveBeenCalledWith(expect.any(InvitationAcceptedEvent));
  });

  it("should return committed degraded evidence when invitation event publication fails", async () => {
    await store.save(createInvitation("accept-fail-token"));

    const membership: Membership = {
      id: "mem-1",
      tenantId: "tenant-1",
      userId: "user-1",
      role: "member",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };

    addMember.mockResolvedValue(membership);
    publishNow.mockRejectedValueOnce(new Error("accept publish failed"));

    const outcome = await manager.acceptInvitation({
      token: "accept-fail-token",
      userId: "user-1",
      email: "member@croco.dev",
    });

    expect(outcome.status).toBe("committed");
    expect(outcome.value.status).toBe("accepted");
    expect(outcome.afterCommit).toMatchObject({
      status: "failed",
      hookCount: 1,
      failures: [{ phase: "hook", message: "accept publish failed" }],
      problem: {
        extensions: {
          committed: true,
          failureCount: 1,
        },
      },
    });
    await expect(store.findById(outcome.value.id)).resolves.toMatchObject({ status: "accepted" });
  });

  it("should accept link invitation without email match check", async () => {
    await store.save(
      createInvitation("accept-link-token", {
        type: "link",
        email: null,
      }),
    );

    addMember.mockResolvedValue({
      id: "mem-1",
      tenantId: "tenant-1",
      userId: "user-2",
      role: "member",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    } as Membership);

    const accepted = await manager.acceptInvitation({
      token: "accept-link-token",
      userId: "user-2",
    });

    expect(addMember).toHaveBeenCalledWith(
      "tenant-1",
      "user-2",
      "member",
      "invitation-accept:inv-1:user-2",
    );
    expect(accepted.status).toBe("committed");
    expect(accepted.value.status).toBe("accepted");
  });

  it("should not expose an unknown bearer token in the serialized Problem", async () => {
    const token = "missing-secret-bearer-token";

    const problem = await manager
      .acceptInvitation({
        token,
        userId: "user-1",
        email: "user@croco.dev",
      })
      .catch((error: unknown) => error);

    expect(problem).toBeInstanceOf(InvitationNotFoundProblem);
    if (!(problem instanceof InvitationNotFoundProblem)) {
      throw problem;
    }

    expect(problem.message).toBe("Invitation not found");
    expect(problem.detail).toBe("Invitation not found");
    expect(problem.extensions).toBeUndefined();
    expect(problem.toJSON()).toEqual({
      type: "about:blank",
      title: "Not Found",
      status: 404,
      detail: "Invitation not found",
      code: "INVITATION_NOT_FOUND",
    });
    expect(problem.stack ?? "").not.toContain(token);
    expect(JSON.stringify(problem)).not.toContain(token);
    expect(inspect(problem)).not.toContain(token);
  });

  it("should ignore identifiers passed to InvitationNotFoundProblem by legacy callers", () => {
    const identifier = "legacy-secret-bearer-token";
    const problem = new InvitationNotFoundProblem(identifier);

    expect(problem.message).toBe("Invitation not found");
    expect(problem.extensions).toBeUndefined();
    expect(JSON.stringify(problem)).not.toContain(identifier);
  });

  it("should mark invitation expired and throw InvitationExpiredProblem", async () => {
    const invitation = createInvitation("expired-token", {
      expiresAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await store.save(invitation);

    await expect(
      manager.acceptInvitation({
        token: "expired-token",
        userId: "user-1",
        email: "member@croco.dev",
      }),
    ).rejects.toBeInstanceOf(InvitationExpiredProblem);

    const expired = await store.findById(invitation.id);
    expect(expired?.status).toBe("expired");
  });

  it("should report a conflict for a valid pending invitation after CAS failure and allow retry", async () => {
    const invitation = createInvitation("cas-conflict-token");
    await store.save(invitation);
    const compareAndSetStatus = vi.spyOn(store, "compareAndSetStatus").mockResolvedValueOnce(null);
    const input = {
      token: "cas-conflict-token",
      userId: "user-1",
      email: "member@croco.dev",
    };

    await expect(manager.acceptInvitation(input)).rejects.toMatchObject({
      code: "INVITATION_INVALID_STATUS",
      category: ProblemCategory.Conflict,
      extensions: {
        invitationId: invitation.id,
        invitationStatus: "pending",
        operation: "accept",
      },
    });

    expect(compareAndSetStatus).toHaveBeenCalledTimes(1);
    expect(await store.findById(invitation.id)).toEqual(invitation);
    expect(addMember).not.toHaveBeenCalled();
    expect(publishNow).not.toHaveBeenCalled();

    const accepted = await manager.acceptInvitation(input);

    expect(accepted.value.status).toBe("accepted");
    expect(addMember).toHaveBeenCalledTimes(1);
    expect(publishNow).toHaveBeenCalledExactlyOnceWith(expect.any(InvitationAcceptedEvent));
  });

  it.each([0, 1])(
    "should reject an invitation %i ms after expiry following lookup",
    async (elapsed) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        const invitation = createInvitation("boundary-token", {
          expiresAt: new Date("2026-01-01T00:00:01.000Z"),
        });
        await store.save(invitation);

        const boundaryTxManager = new TxManager<unknown>({
          async transaction<T>(fn: (client: unknown) => Promise<T>): Promise<T> {
            vi.setSystemTime(new Date(invitation.expiresAt.getTime() + elapsed));
            return fn({});
          },
          async savepoint<T>(_client: unknown, fn: (client: unknown) => Promise<T>): Promise<T> {
            return fn({});
          },
          supportsSavepoint: () => false,
        });
        const boundaryManager = new InvitationManager(
          store,
          { addMember } as unknown as MembershipManager,
          { send } as unknown as NotificationService,
          {
            publishNow,
            publishMany: vi.fn(),
          } as unknown as EventPublisher,
          boundaryTxManager,
        );

        await expect(
          boundaryManager.acceptInvitation({
            token: "boundary-token",
            userId: "user-1",
            email: "member@croco.dev",
          }),
        ).rejects.toBeInstanceOf(InvitationExpiredProblem);

        expect((await store.findById(invitation.id))?.status).toBe("pending");
        expect(addMember).not.toHaveBeenCalled();
        expect(publishNow).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("should report expiration when cleanup expires the invitation before acceptance", async () => {
    const invitation = createInvitation("cleanup-race-token");
    await store.save(invitation);
    vi.spyOn(store, "compareAndSetStatus").mockImplementationOnce(async () => {
      await store.updateStatus(invitation.tenantId, invitation.id, "expired");
      return null;
    });

    await expect(
      manager.acceptInvitation({
        token: "cleanup-race-token",
        userId: "user-1",
        email: "member@croco.dev",
      }),
    ).rejects.toBeInstanceOf(InvitationExpiredProblem);

    expect((await store.findById(invitation.id))?.status).toBe("expired");
    expect(addMember).not.toHaveBeenCalled();
  });

  it.each(["accepted", "revoked", "declined"] as const)(
    "should preserve the %s status diagnosis after a failed CAS even past expiry",
    async (status) => {
      const invitation = createInvitation("status-race-token");
      await store.save(invitation);
      vi.spyOn(store, "compareAndSetStatus").mockImplementationOnce(async () => {
        await store.save({ ...invitation, status, expiresAt: new Date(0) });
        return null;
      });

      await expect(
        manager.acceptInvitation({
          token: "status-race-token",
          userId: "user-1",
          email: "member@croco.dev",
        }),
      ).rejects.toBeInstanceOf(
        status === "accepted" ? InvitationAlreadyAcceptedProblem : InvitationInvalidStatusProblem,
      );

      expect((await store.findById(invitation.id))?.status).toBe(status);
      expect(addMember).not.toHaveBeenCalled();
      expect(publishNow).not.toHaveBeenCalled();
    },
  );

  it("should throw InvitationAlreadyAcceptedProblem for accepted invitation", async () => {
    await store.save(
      createInvitation("accepted-token", {
        status: "accepted",
        acceptedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    );

    await expect(
      manager.acceptInvitation({
        token: "accepted-token",
        userId: "user-1",
        email: "member@croco.dev",
      }),
    ).rejects.toBeInstanceOf(InvitationAlreadyAcceptedProblem);
  });

  it("should allow only one concurrent accept attempt to create membership", async () => {
    await store.save(createInvitation("concurrent-token"));

    addMember.mockResolvedValue({
      id: "mem-1",
      tenantId: "tenant-1",
      userId: "user-1",
      role: "member",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    } as Membership);

    const results = await Promise.allSettled([
      manager.acceptInvitation({
        token: "concurrent-token",
        userId: "user-1",
        email: "member@croco.dev",
      }),
      manager.acceptInvitation({
        token: "concurrent-token",
        userId: "user-2",
        email: "member@croco.dev",
      }),
    ]);

    const accepted = results.find((result) => result.status === "fulfilled");
    const rejected = results.find((result) => result.status === "rejected");

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(accepted?.status === "fulfilled" ? accepted.value.value.status : null).toBe("accepted");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toBeInstanceOf(
      InvitationAlreadyAcceptedProblem,
    );
    expect(addMember).toHaveBeenCalledTimes(1);
  });

  it("should preserve an accepted invitation when a stale decline resumes", async () => {
    const invitation = createInvitation("accept-decline-token");
    await store.save(invitation);

    addMember.mockResolvedValue({
      id: "mem-1",
      tenantId: "tenant-1",
      userId: "user-1",
      role: "member",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    } as Membership);

    const findByTokenHash = store.findByTokenHash.bind(store);
    let releaseDeclineRead!: () => void;
    let markDeclineRead!: () => void;
    const declineRead = new Promise<void>((resolve) => {
      markDeclineRead = resolve;
    });
    const declineReadGate = new Promise<void>((resolve) => {
      releaseDeclineRead = resolve;
    });

    vi.spyOn(store, "findByTokenHash").mockImplementationOnce(async (tokenHash) => {
      const snapshot = await findByTokenHash(tokenHash);
      markDeclineRead();
      await declineReadGate;
      return snapshot;
    });

    const declineResult = manager.declineInvitation("accept-decline-token");
    await declineRead;

    const accepted = await manager.acceptInvitation({
      token: "accept-decline-token",
      userId: "user-1",
      email: "member@croco.dev",
    });
    releaseDeclineRead();

    await expect(declineResult).rejects.toMatchObject({
      extensions: {
        invitationId: invitation.id,
        invitationStatus: "accepted",
        operation: "decline",
      },
    });
    await expect(store.findById(invitation.id)).resolves.toEqual(accepted.value);
    expect(accepted.value.acceptedAt).not.toBeNull();
    expect(addMember).toHaveBeenCalledTimes(1);
    expect(publishNow).toHaveBeenCalledTimes(1);
    expect(publishNow).toHaveBeenCalledWith(expect.any(InvitationAcceptedEvent));
  });

  it("should prevent a stale accept from creating membership after decline wins", async () => {
    const invitation = createInvitation("decline-accept-token");
    await store.save(invitation);

    const findByTokenHash = store.findByTokenHash.bind(store);
    let releaseAcceptRead!: () => void;
    let markAcceptRead!: () => void;
    const acceptRead = new Promise<void>((resolve) => {
      markAcceptRead = resolve;
    });
    const acceptReadGate = new Promise<void>((resolve) => {
      releaseAcceptRead = resolve;
    });

    vi.spyOn(store, "findByTokenHash").mockImplementationOnce(async (tokenHash) => {
      const snapshot = await findByTokenHash(tokenHash);
      markAcceptRead();
      await acceptReadGate;
      return snapshot;
    });

    const acceptResult = manager.acceptInvitation({
      token: "decline-accept-token",
      userId: "user-1",
      email: "member@croco.dev",
    });
    await acceptRead;

    const declined = await manager.declineInvitation("decline-accept-token");
    releaseAcceptRead();

    await expect(acceptResult).rejects.toMatchObject({
      extensions: {
        invitationId: invitation.id,
        invitationStatus: "declined",
        operation: "accept",
      },
    });
    await expect(store.findById(invitation.id)).resolves.toEqual(declined);
    expect(declined).toMatchObject({ status: "declined", acceptedAt: null });
    expect(addMember).not.toHaveBeenCalled();
    expect(publishNow).toHaveBeenCalledTimes(1);
    expect(publishNow).toHaveBeenCalledWith(expect.any(InvitationDeclinedEvent));
  });

  it("should throw InvitationEmailMismatchProblem when email does not match", async () => {
    await store.save(createInvitation("mismatch-token", { email: "member@croco.dev" }));

    await expect(
      manager.acceptInvitation({
        token: "mismatch-token",
        userId: "user-1",
        email: "other@croco.dev",
      }),
    ).rejects.toBeInstanceOf(InvitationEmailMismatchProblem);
  });

  it("should throw InvitationInvalidStatusProblem when invitation is revoked", async () => {
    await store.save(
      createInvitation("revoked-token", {
        status: "revoked",
        revokedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    );

    await expect(
      manager.acceptInvitation({
        token: "revoked-token",
        userId: "user-1",
        email: "member@croco.dev",
      }),
    ).rejects.toBeInstanceOf(InvitationInvalidStatusProblem);
  });

  it("should expose invitation status without overriding the Problem status", () => {
    const problem = new InvitationInvalidStatusProblem("inv-1", "revoked", "accept");

    expect(problem.toJSON()).toMatchObject({
      invitationId: "inv-1",
      invitationStatus: "revoked",
      operation: "accept",
      status: 409,
    });
  });

  it("should decline pending invitation", async () => {
    await store.save(createInvitation("decline-token"));

    const declined = await manager.declineInvitation("decline-token");

    expect(declined.status).toBe("declined");
    expect(publishNow).toHaveBeenCalledWith(expect.any(InvitationDeclinedEvent));
  });

  it("should revoke invitation by id", async () => {
    await store.save(createInvitation("revoke-token", { id: "inv-revoke" }));

    const revoked = await manager.revokeInvitation("inv-revoke");

    expect(revoked.status).toBe("revoked");
    expect(revoked.revokedAt).not.toBeNull();
    expect(publishNow).toHaveBeenCalledWith(expect.any(InvitationRevokedEvent));
  });

  it("should resend invitation by revoking old one and issuing a new token", async () => {
    await store.save(createInvitation("old-token", { id: "inv-old" }));

    const newToken = await manager.resendInvitation("inv-old", "resend-old-1");
    const oldInvitation = await store.findById("inv-old");
    const newInvitation = await store.findByTokenHash(hashToken(newToken));

    expect(oldInvitation?.status).toBe("revoked");
    expect(newInvitation).not.toBeNull();
    if (newInvitation === null) {
      throw new Error("Resent invitation was not created");
    }

    const preferenceContext = {
      tenantId: "tenant-1",
      userId: "member@croco.dev",
      channel: NotificationChannel.EMAIL,
      topic: "invitation.created",
    };

    expect(newInvitation.id).not.toBe("inv-old");
    expect(send).toHaveBeenCalledWith(
      NotificationChannel.EMAIL,
      expect.objectContaining({
        to: "member@croco.dev",
      }),
      {
        idempotencyKey: expect.stringContaining(
          "notification:tenant-1:member%40croco.dev:EMAIL:invitation.created",
        ),
        preferenceContext,
        requireProviderIdempotency: true,
      },
    );
    expect(publishNow).toHaveBeenCalledWith(expect.any(InvitationRevokedEvent));
    expect(publishNow).toHaveBeenCalledWith(expect.any(InvitationCreatedEvent));
  });

  it("should resume a failed link resend with the original token and event identity", async () => {
    await store.save(
      createInvitation("old-link-token", {
        id: "inv-old-link",
        email: null,
        type: "link",
      }),
    );
    publishNow.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("publish failed"));

    await expect(
      manager.resendInvitation("inv-old-link", "resend-old-link-1"),
    ).rejects.toBeInstanceOf(InvitationCreationFailedProblem);
    const token = await manager.resendInvitation("inv-old-link", "resend-old-link-1");

    const invitations = await store.findAllByTenant("tenant-1");
    expect(invitations).toHaveLength(2);
    expect(invitations.filter((invitation) => invitation.status === "pending")).toHaveLength(1);
    expect((await store.findByTokenHash(hashToken(token)))?.type).toBe("link");
    const createdEvents = publishNow.mock.calls
      .map(([event]) => event)
      .filter((event): event is InvitationCreatedEvent => event instanceof InvitationCreatedEvent);
    expect(createdEvents).toHaveLength(2);
    expect(createdEvents[1]?.eventId).toBe(createdEvents[0]?.eventId);
  });

  it("should throw InvitationInvalidStatusProblem when resending accepted invitation", async () => {
    await store.save(
      createInvitation("accepted-resend-token", {
        id: "inv-accepted",
        status: "accepted",
        acceptedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    );

    await expect(
      manager.resendInvitation("inv-accepted", "resend-accepted-1"),
    ).rejects.toBeInstanceOf(InvitationInvalidStatusProblem);
  });
});
