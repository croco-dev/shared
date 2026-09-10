import { beforeEach, describe, expect, it } from "vitest";
import { DomainAutoJoinRecoveryProblem } from "../libs/problems/DomainPolicyProblems";
import { InMemoryDomainPolicyStore } from "../libs/InMemoryDomainPolicyStore";
import type { DomainAutoJoinIntentInput, DomainPolicy } from "../libs/types";

describe("InMemoryDomainPolicyStore", () => {
  let store!: InMemoryDomainPolicyStore;

  const createPolicy = (overrides: Partial<DomainPolicy> = {}): DomainPolicy => {
    return {
      id: overrides.id ?? "dp-1",
      tenantId: overrides.tenantId ?? "tenant-1",
      domain: overrides.domain ?? "croco.dev",
      role: overrides.role ?? "member",
      enabled: overrides.enabled ?? true,
      createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
    };
  };

  const createAutoJoinIntent = (
    overrides: Partial<DomainAutoJoinIntentInput> = {},
  ): DomainAutoJoinIntentInput => ({
    idempotencyKey: overrides.idempotencyKey ?? "auto-join-key",
    tenantId: overrides.tenantId ?? "tenant-1",
    userId: overrides.userId ?? "user-1",
    email: overrides.email ?? "user@croco.dev",
    domain: overrides.domain ?? "croco.dev",
    role: overrides.role ?? "member",
    membership: overrides.membership ?? null,
    eventStatus: overrides.eventStatus ?? "pending",
    eventClaimId: overrides.eventClaimId ?? null,
    eventClaimExpiresAt: overrides.eventClaimExpiresAt ?? null,
    eventId: overrides.eventId ?? "event-1",
    eventOccurredAt: overrides.eventOccurredAt ?? new Date("2026-01-01T00:00:00.000Z"),
    createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
  });

  beforeEach(() => {
    store = new InMemoryDomainPolicyStore();
  });

  it("should save and find policy by tenant and domain", async () => {
    await store.save(createPolicy({ id: "dp-1", tenantId: "tenant-1", domain: "croco.dev" }));

    const policy = await store.findByTenantAndDomain("tenant-1", "croco.dev");

    expect(policy).not.toBeNull();
    expect(policy?.id).toBe("dp-1");
  });

  it("should return all policies by tenant", async () => {
    await store.save(createPolicy({ id: "dp-1", tenantId: "tenant-1", domain: "croco.dev" }));
    await store.save(createPolicy({ id: "dp-2", tenantId: "tenant-1", domain: "example.com" }));
    await store.save(createPolicy({ id: "dp-3", tenantId: "tenant-2", domain: "other.dev" }));

    const policies = await store.findAllByTenant("tenant-1");

    expect(policies).toHaveLength(2);
    expect(policies.map((policy: DomainPolicy) => policy.id).sort()).toEqual(["dp-1", "dp-2"]);
  });

  it("should update existing policy when saving same tenant and domain", async () => {
    await store.save(
      createPolicy({ id: "dp-1", tenantId: "tenant-1", domain: "croco.dev", role: "member" }),
    );
    await store.save(
      createPolicy({ id: "dp-2", tenantId: "tenant-1", domain: "croco.dev", role: "viewer" }),
    );

    const policy = await store.findByTenantAndDomain("tenant-1", "croco.dev");

    expect(policy?.id).toBe("dp-2");
    expect(policy?.role).toBe("viewer");
  });

  it("should delete policy by tenant and domain", async () => {
    await store.save(createPolicy({ id: "dp-1", tenantId: "tenant-1", domain: "croco.dev" }));

    await store.delete("tenant-1", "croco.dev");

    const policy = await store.findByTenantAndDomain("tenant-1", "croco.dev");
    expect(policy).toBeNull();
  });

  it.each([
    [
      createPolicy({ id: "dp-delimiter-left", tenantId: "tenant:segment", domain: "example.com" }),
      createPolicy({ id: "dp-delimiter-right", tenantId: "tenant", domain: "segment:example.com" }),
    ],
    [
      createPolicy({ id: "dp-delimiter-right", tenantId: "tenant", domain: "segment:example.com" }),
      createPolicy({ id: "dp-delimiter-left", tenantId: "tenant:segment", domain: "example.com" }),
    ],
    [
      createPolicy({ id: "dp-unicode-left", tenantId: "조직:개발", domain: "例子.测试" }),
      createPolicy({ id: "dp-unicode-right", tenantId: "조직", domain: "개발:例子.测试" }),
    ],
  ])(
    "should keep delimiter-containing tuples distinct regardless of save order",
    async (first, second) => {
      await store.save(first);
      await store.save(second);

      await expect(store.findByTenantAndDomain(first.tenantId, first.domain)).resolves.toEqual(
        first,
      );
      await expect(store.findByTenantAndDomain(second.tenantId, second.domain)).resolves.toEqual(
        second,
      );

      await store.delete(first.tenantId, first.domain);

      await expect(store.findByTenantAndDomain(first.tenantId, first.domain)).resolves.toBeNull();
      await expect(store.findByTenantAndDomain(second.tenantId, second.domain)).resolves.toEqual(
        second,
      );
    },
  );

  it("should persist one semantic auto-join intent and replay its committed membership", async () => {
    const input = createAutoJoinIntent();
    const membership = {
      id: "membership-1",
      tenantId: input.tenantId,
      userId: input.userId,
      role: input.role,
      createdAt: new Date("2026-01-01T00:01:00.000Z"),
      updatedAt: new Date("2026-01-01T00:01:00.000Z"),
    };

    await expect(store.createAutoJoinIntent(input)).resolves.toMatchObject({ created: true });
    await expect(store.createAutoJoinIntent(input)).resolves.toMatchObject({ created: false });
    await expect(
      store.completeAutoJoinMembership(
        input.tenantId,
        input.idempotencyKey,
        membership,
        input.eventId,
      ),
    ).resolves.toMatchObject({ membership });
    await expect(
      store.findAutoJoinIntent(input.tenantId, input.idempotencyKey),
    ).resolves.toMatchObject({ membership });
  });

  it("should preserve the first committed membership when completion callers race", async () => {
    const input = createAutoJoinIntent();
    await store.createAutoJoinIntent(input);
    const memberships = ["membership-1", "membership-2"].map((id) => ({
      id,
      tenantId: input.tenantId,
      userId: input.userId,
      role: input.role,
      createdAt: new Date("2026-01-01T00:01:00.000Z"),
      updatedAt: new Date("2026-01-01T00:01:00.000Z"),
    }));
    const results = await Promise.all(
      memberships.map((membership) =>
        store.completeAutoJoinMembership(
          input.tenantId,
          input.idempotencyKey,
          membership,
          input.eventId,
        ),
      ),
    );
    expect(results.map((intent) => intent?.membership)).toEqual([memberships[0], memberships[0]]);
    await expect(
      store.findAutoJoinIntent(input.tenantId, input.idempotencyKey),
    ).resolves.toMatchObject({ membership: memberships[0] });
  });

  it.each([false, true])(
    "should atomically renew one completed generation with committed input %s",
    async (committed) => {
      const completed = createAutoJoinIntent({
        eventStatus: "completed",
        membership: {
          id: "membership-1",
          tenantId: "tenant-1",
          userId: "user-1",
          role: "member",
          createdAt: new Date("2026-01-01T00:01:00.000Z"),
          updatedAt: new Date("2026-01-01T00:01:00.000Z"),
        },
      });
      await store.createAutoJoinIntent(completed);
      const inputs = ["event-2", "event-3"].map((eventId) =>
        createAutoJoinIntent({
          eventId,
          role: "viewer",
          email: "changed@croco.dev",
          membership: committed
            ? {
                tenantId: "tenant-1",
                userId: "user-1",
                createdAt: new Date("2026-01-02T00:00:00.000Z"),
                updatedAt: new Date("2026-01-02T00:00:00.000Z"),
                id: "membership-2",
                role: "viewer",
              }
            : null,
        }),
      );

      const results = await Promise.all(
        inputs.map((input) => store.renewAutoJoinIntent(input, completed.eventId)),
      );

      expect(results.map((result) => result.created)).toEqual([true, false]);
      expect(results[0].intent).toEqual(inputs[0]);
      expect(results[1].intent).toEqual(inputs[0]);
      results[0].intent.email = "mutated@croco.dev";
      inputs[0].role = "admin";
      await expect(
        store.findAutoJoinIntent(completed.tenantId, completed.idempotencyKey),
      ).resolves.toMatchObject({
        eventId: "event-2",
        email: "changed@croco.dev",
        role: "viewer",
        membership: committed ? { id: "membership-2", role: "viewer" } : null,
      });
    },
  );

  it.each([
    { eventStatus: "pending" as const, expectedEventId: "event-1", committed: true },
    { eventStatus: "processing" as const, expectedEventId: "event-1", committed: true },
    { eventStatus: "processing" as const, expectedEventId: "event-1", committed: false },
    { eventStatus: "pending" as const, expectedEventId: "stale-event", committed: false },
    { eventStatus: "pending" as const, expectedEventId: "event-1", committed: false },
    { eventStatus: "completed" as const, expectedEventId: "stale-event", committed: true },
    { eventStatus: "completed" as const, expectedEventId: "event-1", committed: false },
  ])(
    "should preserve an intent when its renewal fence does not match: %j",
    async ({ eventStatus, expectedEventId, committed }) => {
      const existing = createAutoJoinIntent({
        eventStatus,
        membership: committed
          ? {
              id: "membership-1",
              tenantId: "tenant-1",
              userId: "user-1",
              role: "member",
              createdAt: new Date("2026-01-01T00:01:00.000Z"),
              updatedAt: new Date("2026-01-01T00:01:00.000Z"),
            }
          : null,
      });
      await store.createAutoJoinIntent(existing);
      await expect(
        store.renewAutoJoinIntent(createAutoJoinIntent({ eventId: "event-2" }), expectedEventId),
      ).resolves.toEqual({ intent: existing, created: false });
      await expect(
        store.findAutoJoinIntent(existing.tenantId, existing.idempotencyKey),
      ).resolves.toEqual(existing);
    },
  );

  it("should reject renewal when the tenant-scoped intent does not exist", async () => {
    await store.createAutoJoinIntent(createAutoJoinIntent());
    await expect(
      store.renewAutoJoinIntent(createAutoJoinIntent({ tenantId: "tenant-2" }), "event-1"),
    ).rejects.toBeInstanceOf(DomainAutoJoinRecoveryProblem);
  });

  it("should fence delayed membership, claim and cleanup operations after renewal", async () => {
    const membership = {
      id: "membership-old",
      tenantId: "tenant-1",
      userId: "user-1",
      role: "member" as const,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const previous = createAutoJoinIntent({ membership, eventStatus: "completed" });
    await store.createAutoJoinIntent(previous);
    const renewed = createAutoJoinIntent({ eventId: "event-2" });
    await store.renewAutoJoinIntent(renewed, previous.eventId);
    await expect(
      store.completeAutoJoinMembership(
        renewed.tenantId,
        renewed.idempotencyKey,
        membership,
        previous.eventId,
      ),
    ).resolves.toEqual(renewed);
    await store.deleteUncommittedAutoJoinIntent(
      renewed.tenantId,
      renewed.idempotencyKey,
      previous.eventId,
    );
    await expect(
      store.findAutoJoinIntent(renewed.tenantId, renewed.idempotencyKey),
    ).resolves.toEqual(renewed);
    const currentMembership = { ...membership, id: "membership-new" };
    await store.completeAutoJoinMembership(
      renewed.tenantId,
      renewed.idempotencyKey,
      currentMembership,
      renewed.eventId,
    );
    await expect(
      store.claimAutoJoinEvent(
        renewed.tenantId,
        renewed.idempotencyKey,
        "stale-claim",
        new Date(Date.now() + 60_000),
        previous.eventId,
      ),
    ).resolves.toBeNull();
    await expect(
      store.claimAutoJoinEvent(
        renewed.tenantId,
        renewed.idempotencyKey,
        "current-claim",
        new Date(Date.now() + 60_000),
        renewed.eventId,
      ),
    ).resolves.toMatchObject({ eventClaimId: "current-claim", membership: currentMembership });
  });

  it("should lease, release, reclaim, and complete auto-join event delivery", async () => {
    const input = createAutoJoinIntent({
      membership: {
        id: "membership-1",
        tenantId: "tenant-1",
        userId: "user-1",
        role: "member",
        createdAt: new Date("2026-01-01T00:01:00.000Z"),
        updatedAt: new Date("2026-01-01T00:01:00.000Z"),
      },
    });
    await store.createAutoJoinIntent(input);

    await expect(
      store.claimAutoJoinEvent(
        input.tenantId,
        input.idempotencyKey,
        "claim-1",
        new Date(Date.now() + 60_000),
        input.eventId,
      ),
    ).resolves.toMatchObject({ eventStatus: "processing", eventClaimId: "claim-1" });
    await expect(
      store.claimAutoJoinEvent(
        input.tenantId,
        input.idempotencyKey,
        "claim-2",
        new Date(Date.now() + 60_000),
        input.eventId,
      ),
    ).resolves.toBeNull();

    await store.releaseAutoJoinEvent(input.tenantId, input.idempotencyKey, "claim-1");
    await expect(
      store.claimAutoJoinEvent(
        input.tenantId,
        input.idempotencyKey,
        "claim-2",
        new Date(Date.now() + 60_000),
        input.eventId,
      ),
    ).resolves.toMatchObject({ eventClaimId: "claim-2" });
    await expect(
      store.completeAutoJoinEvent(input.tenantId, input.idempotencyKey, "claim-2"),
    ).resolves.toMatchObject({ eventStatus: "completed", eventClaimId: null });
  });

  it("should delete only auto-join intents without a committed membership", async () => {
    const pending = createAutoJoinIntent({ idempotencyKey: "pending" });
    const committed = createAutoJoinIntent({
      idempotencyKey: "committed",
      membership: {
        id: "membership-1",
        tenantId: "tenant-1",
        userId: "user-1",
        role: "member",
        createdAt: new Date("2026-01-01T00:01:00.000Z"),
        updatedAt: new Date("2026-01-01T00:01:00.000Z"),
      },
    });
    await store.createAutoJoinIntent(pending);
    await store.createAutoJoinIntent(committed);

    await store.deleteUncommittedAutoJoinIntent(
      pending.tenantId,
      pending.idempotencyKey,
      pending.eventId,
    );
    await store.deleteUncommittedAutoJoinIntent(
      committed.tenantId,
      committed.idempotencyKey,
      committed.eventId,
    );

    await expect(
      store.findAutoJoinIntent(pending.tenantId, pending.idempotencyKey),
    ).resolves.toBeNull();
    await expect(
      store.findAutoJoinIntent(committed.tenantId, committed.idempotencyKey),
    ).resolves.toMatchObject({ membership: committed.membership });
  });
});
