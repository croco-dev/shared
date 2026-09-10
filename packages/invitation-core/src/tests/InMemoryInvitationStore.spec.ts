import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryInvitationStore } from "../libs/InMemoryInvitationStore";
import type { Invitation } from "../libs/types";

describe("InMemoryInvitationStore compareAndSetStatus", () => {
  let store!: InMemoryInvitationStore;

  const createInvitation = (overrides: Partial<Invitation> = {}): Invitation => {
    return {
      id: overrides.id ?? "inv-1",
      tenantId: overrides.tenantId ?? "tenant-1",
      inviterId: overrides.inviterId ?? "user-1",
      email: overrides.email ?? "member@croco.dev",
      tokenHash: overrides.tokenHash ?? "hash-1",
      type: overrides.type ?? "email",
      role: overrides.role ?? "member",
      status: overrides.status ?? "pending",
      expiresAt: overrides.expiresAt ?? new Date("2026-01-10T00:00:00.000Z"),
      acceptedAt: overrides.acceptedAt ?? null,
      revokedAt: overrides.revokedAt ?? null,
      createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
    };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    store = new InMemoryInvitationStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should count issued invitations across statuses with inclusive time and tenant boundaries", async () => {
    const since = new Date("2026-01-01T00:00:00.000Z");
    const statuses = ["creating", "pending", "accepted", "revoked", "declined", "expired"] as const;
    for (const status of statuses) {
      await store.save(createInvitation({ id: status, status, createdAt: since }));
    }
    await store.save(createInvitation({ id: "old", createdAt: new Date(since.getTime() - 1) }));
    await store.save(createInvitation({ id: "other", tenantId: "tenant-2", createdAt: since }));
    await store.save(createInvitation({ id: "new", createdAt: new Date(since.getTime() + 1) }));

    expect(await store.countIssuedByTenant("tenant-1", since)).toBe(7);
    expect(await store.countIssuedByTenant("tenant-2", since)).toBe(1);
    expect(await store.countIssuedByTenant("missing", since)).toBe(0);
    expect(await store.countPendingByTenant("tenant-1", since)).toBe(2);
  });

  it("should allow only one concurrent status transition from the expected status", async () => {
    const acceptedAt = new Date("2026-01-02T00:00:00.000Z");
    await store.save(createInvitation({ id: "inv-1", status: "pending" }));

    const results = await Promise.all([
      store.compareAndSetStatus("tenant-1", "inv-1", "pending", "accepted", { acceptedAt }),
      store.compareAndSetStatus("tenant-1", "inv-1", "pending", "accepted", { acceptedAt }),
    ]);

    const successful = results.filter((result): result is Invitation => result !== null);
    const failed = results.filter((result) => result === null);

    expect(successful).toHaveLength(1);
    expect(successful[0].status).toBe("accepted");
    expect(successful[0].acceptedAt).toEqual(acceptedAt);
    expect(failed).toHaveLength(1);
  });

  it("should reject acceptance at or after the invitation expiry", async () => {
    const expiresAt = new Date("2026-01-02T00:00:00.000Z");
    await store.save(createInvitation({ expiresAt }));

    const result = await store.compareAndSetStatus("tenant-1", "inv-1", "pending", "accepted", {
      acceptedAt: new Date(expiresAt),
    });

    expect(result).toBeNull();
    expect((await store.findById("inv-1"))?.status).toBe("pending");
  });

  it("should use the transition time when acceptedAt is omitted", async () => {
    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
    await store.save(createInvitation({ expiresAt: new Date("2026-01-02T00:00:00.000Z") }));

    await expect(
      store.compareAndSetStatus("tenant-1", "inv-1", "pending", "accepted"),
    ).resolves.toBeNull();
  });

  it("should not let a supplied acceptance time bypass the transition time", async () => {
    const expiresAt = new Date("2026-01-02T00:00:00.000Z");
    await store.save(createInvitation({ expiresAt }));
    vi.setSystemTime(new Date("2026-01-03T00:00:00.000Z"));

    const result = await store.compareAndSetStatus("tenant-1", "inv-1", "pending", "accepted", {
      acceptedAt: new Date("2026-01-01T23:59:59.999Z"),
    });

    expect(result).toBeNull();
    expect((await store.findById("inv-1"))?.status).toBe("pending");
  });

  it("should accept an invitation before its expiry", async () => {
    await store.save(createInvitation({ expiresAt: new Date("2026-01-02T00:00:00.000Z") }));
    const acceptedAt = new Date("2026-01-01T23:59:59.999Z");

    const result = await store.compareAndSetStatus("tenant-1", "inv-1", "pending", "accepted", {
      acceptedAt,
    });

    expect(result?.status).toBe("accepted");
    expect(result?.acceptedAt).toEqual(acceptedAt);
  });
});
