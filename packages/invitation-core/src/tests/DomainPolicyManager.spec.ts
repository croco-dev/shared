import "reflect-metadata";
import type { EventPublisher } from "@croco/events-core";
import type { Membership } from "@croco/membership-core";
import {
  AlreadyMemberProblem,
  MembershipService,
  InMemoryMembershipStore,
  MembershipNotFoundProblem,
  type MembershipManager,
} from "@croco/membership-core";
import { TxManager, type TxAdapter } from "@croco/tx-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainPolicyManager } from "../libs/DomainPolicyManager";
import {
  DomainAutoJoinedEvent,
  DomainPolicyAddedEvent,
  DomainPolicyRemovedEvent,
} from "../libs/events/DomainPolicyEvents";
import { InMemoryDomainPolicyStore } from "../libs/InMemoryDomainPolicyStore";
import {
  DomainAutoJoinRecoveryProblem,
  InvalidAutoJoinRoleProblem,
  PublicEmailDomainNotAllowedProblem,
} from "../libs/problems/DomainPolicyProblems";

describe("DomainPolicyManager", () => {
  let manager!: DomainPolicyManager;
  let store!: InMemoryDomainPolicyStore;
  let publishNow!: ReturnType<typeof vi.fn>;
  let addMemberCommand!: ReturnType<typeof vi.fn>;
  let getMember!: ReturnType<typeof vi.fn>;
  let txManager!: TxManager<unknown>;

  beforeEach(() => {
    store = new InMemoryDomainPolicyStore();
    publishNow = vi.fn();
    addMemberCommand = vi.fn();
    getMember = vi.fn(async () => {
      const membership = (await addMemberCommand.mock.results.at(-1)?.value)?.membership;
      if (!membership) throw new MembershipNotFoundProblem("tenant-1", "user-1");
      return membership;
    });
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

    manager = new DomainPolicyManager(
      store,
      { addMemberCommand, getMember } as unknown as MembershipManager,
      {
        publishNow,
        publishMany: vi.fn(),
      } as unknown as EventPublisher,
      txManager,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should add domain policy with normalized domain", async () => {
    const policy = await manager.addDomainPolicy("tenant-1", "  Croco.Dev  ", "member");

    expect(policy.tenantId).toBe("tenant-1");
    expect(policy.domain).toBe("croco.dev");
    expect(policy.role).toBe("member");
    expect(policy.enabled).toBe(true);
    expect(publishNow).toHaveBeenCalledWith(expect.any(DomainPolicyAddedEvent));

    const [event] = publishNow.mock.calls[0] as [DomainPolicyAddedEvent];
    expect(event.data).toEqual({ tenantId: "tenant-1", domain: "croco.dev", role: "member" });
  });

  it("should propagate event publication failures when adding domain policy", async () => {
    publishNow.mockRejectedValueOnce(new Error("publish failed"));

    await expect(manager.addDomainPolicy("tenant-1", "croco.dev", "member")).rejects.toThrow(
      "publish failed",
    );
  });

  it("should reject public email domains", async () => {
    await expect(manager.addDomainPolicy("tenant-1", "gmail.com", "member")).rejects.toBeInstanceOf(
      PublicEmailDomainNotAllowedProblem,
    );
  });

  it("should reject admin and owner role for auto-join", async () => {
    await expect(manager.addDomainPolicy("tenant-1", "croco.dev", "admin")).rejects.toBeInstanceOf(
      InvalidAutoJoinRoleProblem,
    );

    await expect(manager.addDomainPolicy("tenant-1", "croco.dev", "owner")).rejects.toBeInstanceOf(
      InvalidAutoJoinRoleProblem,
    );
  });

  it("should list policies by tenant", async () => {
    await manager.addDomainPolicy("tenant-1", "croco.dev", "member");
    await manager.addDomainPolicy("tenant-1", "example.com", "viewer");
    await manager.addDomainPolicy("tenant-2", "other.dev", "member");

    const policies = await manager.listDomainPolicies("tenant-1");

    expect(policies).toHaveLength(2);
    expect(policies.map((policy) => policy.domain).sort()).toEqual(["croco.dev", "example.com"]);
  });

  it("should remove domain policy with normalized domain", async () => {
    await manager.addDomainPolicy("tenant-1", "croco.dev", "member");

    await manager.removeDomainPolicy("tenant-1", " Croco.Dev ");

    const policy = await store.findByTenantAndDomain("tenant-1", "croco.dev");
    expect(policy).toBeNull();
    expect(publishNow).toHaveBeenCalledWith(expect.any(DomainPolicyRemovedEvent));
  });

  it("should auto-join member when email domain matches policy", async () => {
    await manager.addDomainPolicy("tenant-1", "croco.dev", "member");

    const membership: Membership = {
      id: "mem-1",
      tenantId: "tenant-1",
      userId: "user-1",
      role: "member",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    addMemberCommand.mockResolvedValue({ operation: "add", membership, replayed: false });

    const result = await manager.tryAutoJoin("tenant-1", "user-1", "  User@Croco.Dev  ");

    expect(addMemberCommand).toHaveBeenCalledWith(
      "tenant-1",
      "user-1",
      "member",
      expect.stringMatching(/^domain-auto-join:/u),
    );
    expect(result).toEqual(membership);
    expect(publishNow).toHaveBeenCalledWith(expect.any(DomainAutoJoinedEvent));
  });

  it("should auto-join member when an internationalized domain matches its registered form", async () => {
    await manager.addDomainPolicy("tenant-1", "例え.テスト", "member");

    const membership: Membership = {
      id: "mem-1",
      tenantId: "tenant-1",
      userId: "user-1",
      role: "member",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    addMemberCommand.mockResolvedValue({ operation: "add", membership, replayed: false });

    const result = await manager.tryAutoJoin("tenant-1", "user-1", "User@例え.テスト");

    expect(result).toEqual(membership);
    expect(addMemberCommand).toHaveBeenCalledWith(
      "tenant-1",
      "user-1",
      "member",
      expect.stringMatching(/^domain-auto-join:/u),
    );
  });

  it.each([
    "attacker@croco.dev@evil.example",
    "@croco.dev",
    "user@",
    "   @croco.dev",
    "user@   ",
    "user name@croco.dev",
    "user@croco .dev",
  ])("should reject malformed email %j without side effects", async (email) => {
    await manager.addDomainPolicy("tenant-1", "croco.dev", "member");
    publishNow.mockClear();

    const result = await manager.tryAutoJoin("tenant-1", "user-1", email);

    expect(result).toBeNull();
    expect(addMemberCommand).not.toHaveBeenCalled();
    expect(publishNow).not.toHaveBeenCalled();
  });

  it("should propagate event publication failures after auto-join", async () => {
    await manager.addDomainPolicy("tenant-1", "croco.dev", "member");

    const membership: Membership = {
      id: "mem-1",
      tenantId: "tenant-1",
      userId: "user-1",
      role: "member",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };

    addMemberCommand.mockResolvedValue({ operation: "add", membership, replayed: false });
    publishNow.mockClear();
    publishNow.mockRejectedValueOnce(new Error("auto join publish failed"));

    await expect(manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev")).rejects.toMatchObject(
      {
        extensions: {
          committed: true,
          failures: [{ message: "auto join publish failed" }],
        },
      },
    );
  });

  it("should preserve the publish failure when releasing the event claim also fails", async () => {
    await manager.addDomainPolicy("tenant-1", "croco.dev", "member");

    const membership: Membership = {
      id: "mem-1",
      tenantId: "tenant-1",
      userId: "user-1",
      role: "member",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const publishError = new Error("auto join publish failed");
    const cleanupError = new Error("event claim release failed");

    addMemberCommand.mockResolvedValue({ operation: "add", membership, replayed: false });
    publishNow.mockClear();
    publishNow.mockRejectedValueOnce(publishError);
    vi.spyOn(store, "releaseAutoJoinEvent").mockRejectedValueOnce(cleanupError);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const attempt = manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev");

    await expect(attempt).rejects.toMatchObject({
      cause: publishError,
      extensions: {
        committed: true,
        failures: [{ message: publishError.message }],
      },
    });
    expect(publishError).toHaveProperty("autoJoinCleanupError", cleanupError);
    expect(consoleError).toHaveBeenCalledWith(
      "[DomainPolicyManager] Failed to clean up auto-join state",
      {
        operation: "releaseAutoJoinEvent",
        originalError: publishError,
        cleanupError,
      },
    );
  });

  it("should replay a committed auto-join and publish its missing event on retry", async () => {
    await manager.addDomainPolicy("tenant-1", "croco.dev", "member");

    const membership: Membership = {
      id: "mem-1",
      tenantId: "tenant-1",
      userId: "user-1",
      role: "member",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };

    addMemberCommand.mockResolvedValueOnce({ operation: "add", membership, replayed: false });
    publishNow.mockClear();
    publishNow
      .mockRejectedValueOnce(new Error("auto join publish failed"))
      .mockResolvedValueOnce(undefined);

    await expect(manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev")).rejects.toMatchObject(
      {
        extensions: {
          committed: true,
          failures: [{ message: "auto join publish failed" }],
        },
      },
    );

    await expect(manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev")).resolves.toEqual(
      membership,
    );
    expect(addMemberCommand).toHaveBeenCalledTimes(1);
    expect(publishNow).toHaveBeenCalledTimes(2);
    const [firstEvent] = publishNow.mock.calls[0] as [DomainAutoJoinedEvent];
    const [retriedEvent] = publishNow.mock.calls[1] as [DomainAutoJoinedEvent];
    expect(retriedEvent.eventId).toBe(firstEvent.eventId);
    expect(retriedEvent.timestamp).toEqual(firstEvent.timestamp);
  });

  it("should fence concurrent auto-joins to one membership result and one event", async () => {
    await manager.addDomainPolicy("tenant-1", "croco.dev", "member");
    const membership: Membership = {
      id: "mem-concurrent",
      tenantId: "tenant-1",
      userId: "user-1",
      role: "member",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    addMemberCommand.mockResolvedValue({ operation: "add", membership, replayed: false });
    publishNow.mockClear();
    let releasePublish!: () => void;
    publishNow.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releasePublish = resolve;
        }),
    );

    const firstAttempt = manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev");
    await vi.waitFor(() => expect(publishNow).toHaveBeenCalledTimes(1));

    await expect(
      manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev"),
    ).rejects.toBeInstanceOf(DomainAutoJoinRecoveryProblem);
    expect(addMemberCommand).toHaveBeenCalledTimes(1);
    expect(publishNow).toHaveBeenCalledTimes(1);
    expect(publishNow).toHaveBeenCalledWith(expect.any(DomainAutoJoinedEvent));

    releasePublish();
    await expect(firstAttempt).resolves.toEqual(membership);
    await expect(manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev")).resolves.toEqual(
      membership,
    );
    expect(publishNow).toHaveBeenCalledTimes(1);
  });

  describe("membership revalidation", () => {
    let memberships: MembershipService;

    beforeEach(() => {
      memberships = new MembershipService({
        store: new InMemoryMembershipStore(),
        eventDelivery: "development",
      });
      manager = new DomainPolicyManager(
        store,
        memberships,
        { publishNow } as unknown as EventPublisher,
        txManager,
      );
    });

    it("should recreate deleted memberships repeatedly with distinct commands and events", async () => {
      await manager.addDomainPolicy("tenant-1", "croco.dev", "member");
      publishNow.mockClear();
      const first = await manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev");
      await memberships.removeMember("tenant-1", "user-1", "remove-1");
      const second = await manager.tryAutoJoin("tenant-1", "user-1", " User@Croco.Dev ");
      expect(second?.id).not.toBe(first?.id);
      expect(await memberships.getMember("tenant-1", "user-1")).toEqual(second);
      await memberships.removeMember("tenant-1", "user-1", "remove-2");
      const third = await manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev");
      expect(third?.id).not.toBe(second?.id);
      expect(await memberships.getMember("tenant-1", "user-1")).toEqual(third);
      expect(publishNow).toHaveBeenCalledTimes(3);
      expect(new Set(publishNow.mock.calls.map(([event]) => event.eventId)).size).toBe(3);
    });

    it("should return current role without recreating an existing membership", async () => {
      await manager.addDomainPolicy("tenant-1", "croco.dev", "member");
      await manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev");
      const current = await memberships.updateRole("tenant-1", "user-1", "viewer", "role-change");
      publishNow.mockClear();
      expect(await manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev")).toEqual(current);
      expect(publishNow).not.toHaveBeenCalled();
    });

    it.each(["removed", "disabled"])("should not rejoin under a %s policy", async (state) => {
      const policy = await manager.addDomainPolicy("tenant-1", "croco.dev", "member");
      await manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev");
      await memberships.removeMember("tenant-1", "user-1", "remove");
      if (state === "removed") await store.delete("tenant-1", "croco.dev");
      else await store.save({ ...policy, enabled: false });
      publishNow.mockClear();
      expect(await manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev")).toBeNull();
      await expect(memberships.getMember("tenant-1", "user-1")).rejects.toBeInstanceOf(
        MembershipNotFoundProblem,
      );
      expect(publishNow).not.toHaveBeenCalled();
    });

    it("should use the current policy role when rejoining", async () => {
      await manager.addDomainPolicy("tenant-1", "croco.dev", "member");
      await manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev");
      await memberships.removeMember("tenant-1", "user-1", "remove");
      await manager.addDomainPolicy("tenant-1", "croco.dev", "viewer");
      expect(await manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev")).toMatchObject({
        role: "viewer",
      });
    });

    it("should recover a rejoin after the membership commits but intent completion fails", async () => {
      await manager.addDomainPolicy("tenant-1", "croco.dev", "member");
      await manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev");
      await memberships.removeMember("tenant-1", "user-1", "remove");
      const complete = vi.spyOn(store, "completeAutoJoinMembership");
      complete.mockRejectedValueOnce(new Error("intent write failed"));
      await expect(manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev")).rejects.toThrow(
        "intent write failed",
      );
      const committed = await memberships.getMember("tenant-1", "user-1");
      publishNow.mockClear();
      expect(await manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev")).toEqual(committed);
      expect(publishNow).toHaveBeenCalledTimes(1);
    });

    it("should replay the same rejoin event after publication failure", async () => {
      await manager.addDomainPolicy("tenant-1", "croco.dev", "member");
      await manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev");
      await memberships.removeMember("tenant-1", "user-1", "remove");
      publishNow.mockClear();
      publishNow.mockRejectedValueOnce(new Error("publish unavailable"));
      await expect(
        manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev"),
      ).rejects.toMatchObject({ extensions: { committed: true } });
      const committed = await memberships.getMember("tenant-1", "user-1");
      expect(await manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev")).toEqual(committed);
      const [first, retry] = publishNow.mock.calls.map(([event]) => event);
      expect(retry.eventId).toBe(first.eventId);
      expect(retry.timestamp).toEqual(first.timestamp);
    });

    it("should fence concurrent rejoin commands to one new membership and event", async () => {
      await manager.addDomainPolicy("tenant-1", "croco.dev", "member");
      const original = await manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev");
      await memberships.removeMember("tenant-1", "user-1", "remove");
      publishNow.mockClear();
      const results = await Promise.allSettled([
        manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev"),
        manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev"),
      ]);
      const current = await memberships.getMember("tenant-1", "user-1");
      expect(current.id).not.toBe(original?.id);
      expect(results.some((result) => result.status === "fulfilled")).toBe(true);
      for (const result of results) {
        if (result.status === "fulfilled") expect(result.value).toEqual(current);
        else expect(result.reason).toBeInstanceOf(DomainAutoJoinRecoveryProblem);
      }
      expect(publishNow).toHaveBeenCalledTimes(1);
      expect(await manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev")).toEqual(current);
      expect(publishNow).toHaveBeenCalledTimes(1);
    });

    it.each(["completion", "claim"])(
      "should reject delayed %s from an older generation",
      async (surface) => {
        await manager.addDomainPolicy("tenant-1", "croco.dev", "member");
        let releaseFirst!: () => void;
        let releaseThird!: () => void;
        const firstGate = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        const thirdGate = new Promise<void>((resolve) => {
          releaseThird = resolve;
        });
        let calls = 0;
        const gate = async () => {
          const call = ++calls;
          if (call === 1) await firstGate;
          if (call === 3) await thirdGate;
        };
        const complete = store.completeAutoJoinMembership.bind(store);
        const claim = store.claimAutoJoinEvent.bind(store);
        if (surface === "completion") {
          vi.spyOn(store, "completeAutoJoinMembership").mockImplementation(async (...args) => {
            await gate();
            return complete(...args);
          });
        } else {
          vi.spyOn(store, "claimAutoJoinEvent").mockImplementation(async (...args) => {
            await gate();
            return claim(...args);
          });
        }
        const first = manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev");
        const staleFailure = expect(first).rejects.toBeInstanceOf(DomainAutoJoinRecoveryProblem);
        await vi.waitFor(() => expect(calls).toBe(1));
        const original = await manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev");
        await memberships.removeMember("tenant-1", "user-1", "remove");
        const rejoin = manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev");
        await vi.waitFor(() => expect(calls).toBe(3));
        const current = await memberships.getMember("tenant-1", "user-1");
        expect(current.id).not.toBe(original?.id);
        releaseFirst();
        await staleFailure;
        releaseThird();
        expect(await rejoin).toEqual(current);
      },
    );

    it.each(["removed", "disabled", "role changed"])(
      "should recheck policy after a seat rejection when policy is %s",
      async (state) => {
        let maxSeats = 0;
        memberships = new MembershipService({
          store: new InMemoryMembershipStore(),
          eventDelivery: "development",
          seatLimitChecker: {
            getMaxSeats: async () => maxSeats,
            checkSeatAvailability: vi.fn(),
            getCurrentMemberCount: vi.fn(),
          },
        });
        manager = new DomainPolicyManager(
          store,
          memberships,
          { publishNow } as unknown as EventPublisher,
          txManager,
        );
        const policy = await manager.addDomainPolicy("tenant-1", "croco.dev", "member");
        await expect(
          manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev"),
        ).rejects.toMatchObject({ code: "SEAT_LIMIT_EXCEEDED" });
        maxSeats = 1;
        if (state === "removed") await store.delete("tenant-1", "croco.dev");
        else await store.save({ ...policy, enabled: state !== "disabled", role: "viewer" });
        if (state === "role changed") {
          await expect(
            manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev"),
          ).rejects.toBeInstanceOf(DomainAutoJoinRecoveryProblem);
        } else {
          const result = await manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev");
          expect(result).toBeNull();
          await expect(memberships.getMember("tenant-1", "user-1")).rejects.toBeInstanceOf(
            MembershipNotFoundProblem,
          );
        }
      },
    );

    it("should preserve a concurrent successful command when another attempt rejects seats", async () => {
      let maxSeats = 0;
      memberships = new MembershipService({
        store: new InMemoryMembershipStore(),
        eventDelivery: "development",
        seatLimitChecker: {
          getMaxSeats: async () => maxSeats,
          checkSeatAvailability: vi.fn(),
          getCurrentMemberCount: vi.fn(),
        },
      });
      manager = new DomainPolicyManager(
        store,
        memberships,
        { publishNow } as unknown as EventPublisher,
        txManager,
      );
      await manager.addDomainPolicy("tenant-1", "croco.dev", "member");
      publishNow.mockClear();
      let releaseFailure!: () => void;
      let releaseCompletion!: () => void;
      const failureGate = new Promise<void>((resolve) => {
        releaseFailure = resolve;
      });
      const completionGate = new Promise<void>((resolve) => {
        releaseCompletion = resolve;
      });
      let failed = false;
      let completing = false;
      const add = memberships.addMemberCommand.bind(memberships);
      vi.spyOn(memberships, "addMemberCommand").mockImplementation(async (...args) => {
        try {
          return await add(...args);
        } catch (error) {
          failed = true;
          await failureGate;
          throw error;
        }
      });
      const complete = store.completeAutoJoinMembership.bind(store);
      vi.spyOn(store, "completeAutoJoinMembership").mockImplementation(async (...args) => {
        completing = true;
        await completionGate;
        return complete(...args);
      });
      const first = manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev");
      const rejection = expect(first).rejects.toMatchObject({ code: "SEAT_LIMIT_EXCEEDED" });
      await vi.waitFor(() => expect(failed).toBe(true));
      maxSeats = 1;
      const second = manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev");
      await vi.waitFor(() => expect(completing).toBe(true));
      releaseFailure();
      await rejection;
      releaseCompletion();
      const current = await memberships.getMember("tenant-1", "user-1");
      expect(await second).toEqual(current);
      expect(await manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev")).toEqual(current);
      expect(publishNow).toHaveBeenCalledTimes(1);
    });

    it("should finish committed membership recovery after the policy is removed", async () => {
      await manager.addDomainPolicy("tenant-1", "croco.dev", "member");
      vi.spyOn(store, "completeAutoJoinMembership").mockRejectedValueOnce(
        new Error("intent unavailable"),
      );
      await expect(manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev")).rejects.toThrow(
        "intent unavailable",
      );
      const committed = await memberships.getMember("tenant-1", "user-1");
      await store.delete("tenant-1", "croco.dev");
      publishNow.mockClear();
      expect(await manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev")).toEqual(committed);
      expect(publishNow).toHaveBeenCalledTimes(1);
    });

    it("should propagate lookup failures without renewing the intent", async () => {
      await manager.addDomainPolicy("tenant-1", "croco.dev", "member");
      await manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev");
      const failure = new Error("membership lookup unavailable");
      vi.spyOn(memberships, "getMember").mockRejectedValueOnce(failure);
      publishNow.mockClear();
      await expect(manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev")).rejects.toBe(
        failure,
      );
      expect(publishNow).not.toHaveBeenCalled();
    });
  });

  it("should return null when no matching policy exists", async () => {
    const result = await manager.tryAutoJoin("tenant-1", "user-1", "user@unknown.dev");

    expect(result).toBeNull();
    expect(addMemberCommand).not.toHaveBeenCalled();
  });

  it("should return null when user is already a member", async () => {
    await manager.addDomainPolicy("tenant-1", "croco.dev", "viewer");
    addMemberCommand.mockRejectedValue(new AlreadyMemberProblem("tenant-1", "user-1"));

    const result = await manager.tryAutoJoin("tenant-1", "user-1", "user@croco.dev");

    expect(result).toBeNull();
    expect(getMember).toHaveBeenCalledWith("tenant-1", "user-1");
  });
});
