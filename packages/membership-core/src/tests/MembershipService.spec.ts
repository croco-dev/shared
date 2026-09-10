import "reflect-metadata";
import type { DomainEvent } from "@croco/events-core";
import { describe, expect, it, vi } from "vitest";
import { InMemoryMembershipStore as BaseInMemoryMembershipStore } from "../libs/InMemoryMembershipStore";
import { MembershipService } from "../libs/MembershipService";
import {
  InvalidRoleProblem,
  LastOwnerProblem,
  MembershipEventPublicationProblem,
  MembershipIdempotencyConflictProblem,
  MembershipNotFoundProblem,
  OwnershipTransferRequiredProblem,
  RoleHierarchyViolationProblem,
  SeatLimitExceededProblem,
} from "../libs/problems/MembershipProblems";
import { LastOwnerCannotBeRemovedProblem } from "../libs/problems/LastOwnerCannotBeRemovedProblem";
import type {
  Membership,
  MembershipCreateInput,
  MembershipCommand,
  MembershipCommandResult,
} from "../libs/types";

class InMemoryMembershipStore extends BaseInMemoryMembershipStore {
  public seed(input: MembershipCreateInput): Promise<Membership> {
    return super.save(input);
  }
}

function createService(
  store: InMemoryMembershipStore,
  publishIdempotently: (event: DomainEvent) => Promise<void>,
): MembershipService {
  return new MembershipService({
    store,
    eventDelivery: "development",
    idGenerator: () => "membership-1",
    eventPublisher: { publishIdempotently },
  });
}

describe("MembershipService atomic commands", () => {
  it.each(["admin", "member", "viewer"] as const)(
    "rejects %s promotion to owner without recording a command or event",
    async (role) => {
      const store = new InMemoryMembershipStore();
      await store.seed({ id: "member", tenantId: "tenant-1", userId: "member", role });
      const service = createService(store, async () => undefined);

      await expect(
        service.updateRole("tenant-1", "member", "owner", "forbidden-promotion"),
      ).rejects.toBeInstanceOf(RoleHierarchyViolationProblem);
      await expect(store.findByTenantAndUser("tenant-1", "member")).resolves.toMatchObject({
        role,
      });
      await expect(store.hasExecutedCommand("forbidden-promotion")).resolves.toBe(false);
      await expect(store.listPendingEventIntents()).resolves.toHaveLength(0);
      await expect(
        store.execute({
          operation: "update_role",
          tenantId: "tenant-1",
          userId: "member",
          role: "owner",
          idempotencyKey: "direct-promotion",
        }),
      ).rejects.toMatchObject({
        code: "ROLE_HIERARCHY_VIOLATION",
        extensions: { fromRole: role, toRole: "owner", operation: "promote" },
      });
    },
  );

  it.each(["admin", "member", "viewer"] as const)(
    "allows ordinary transitions from %s",
    async (role) => {
      for (const newRole of ["admin", "member", "viewer"] as const) {
        const store = new InMemoryMembershipStore();
        await store.seed({ id: "member", tenantId: "tenant-1", userId: "member", role });
        const service = createService(store, async () => undefined);
        await expect(
          service.updateRole("tenant-1", "member", newRole, "change-role"),
        ).resolves.toMatchObject({ role: newRole });
      }
    },
  );

  it("replays an owner no-op after a later ownership transfer", async () => {
    const store = new InMemoryMembershipStore();
    await store.seed({ id: "owner", tenantId: "tenant-1", userId: "owner", role: "owner" });
    await store.seed({ id: "member", tenantId: "tenant-1", userId: "member", role: "member" });
    const service = createService(store, async () => undefined);
    await expect(
      service.updateRole("tenant-1", "owner", "owner", "owner-noop"),
    ).resolves.toMatchObject({ role: "owner" });
    await expect(store.listPendingEventIntents()).resolves.toHaveLength(0);
    await service.transferOwnership("tenant-1", "owner", "member", "transfer");
    await expect(
      service.updateRole("tenant-1", "owner", "owner", "owner-noop"),
    ).resolves.toMatchObject({ role: "owner" });
    await expect(service.getMember("tenant-1", "owner")).resolves.toMatchObject({ role: "admin" });
    await expect(
      service.updateRole("tenant-1", "owner", "owner", "new-promotion"),
    ).rejects.toBeInstanceOf(RoleHierarchyViolationProblem);
  });

  it("allows exactly one concurrent addition for the final seat", async () => {
    const store = new InMemoryMembershipStore();
    const service = new MembershipService({
      store,
      eventDelivery: "development",
      eventPublisher: { publishIdempotently: async () => undefined },
      seatLimitChecker: {
        checkSeatAvailability: async () => ({
          usage: 0,
          quota: 1,
          exceeded: false,
          remaining: 1,
        }),
        getCurrentMemberCount: async () => store.countAll("tenant-1"),
        getMaxSeats: async () => 1,
      },
    });

    const results = await Promise.allSettled([
      service.addMember("tenant-1", "user-1", "member", "add:user-1"),
      service.addMember("tenant-1", "user-2", "member", "add:user-2"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.any(SeatLimitExceededProblem),
    });
    await expect(store.countAll("tenant-1")).resolves.toBe(1);
    await expect(store.listPendingEventIntents()).resolves.toHaveLength(1);
  });

  it("keeps positive-infinity plans unlimited", async () => {
    const store = new InMemoryMembershipStore();
    const service = new MembershipService({
      store,
      eventDelivery: "development",
      eventPublisher: { publishIdempotently: async () => undefined },
      seatLimitChecker: {
        checkSeatAvailability: async () => ({
          usage: 0,
          quota: Number.POSITIVE_INFINITY,
          exceeded: false,
          remaining: Number.POSITIVE_INFINITY,
        }),
        getCurrentMemberCount: async () => store.countAll("tenant-1"),
        getMaxSeats: async () => Number.POSITIVE_INFINITY,
      },
    });

    await service.addMember("tenant-1", "user-1", "member", "add:user-1");
    await service.addMember("tenant-1", "user-2", "member", "add:user-2");

    await expect(store.countAll("tenant-1")).resolves.toBe(2);
  });

  it("replays a committed add without rechecking capacity", async () => {
    const store = new InMemoryMembershipStore();
    let quotaAvailable = true;
    const service = new MembershipService({
      store,
      eventDelivery: "development",
      eventPublisher: { publishIdempotently: async () => undefined },
      seatLimitChecker: {
        checkSeatAvailability: async () => ({
          usage: 0,
          quota: 1,
          exceeded: false,
          remaining: 1,
        }),
        getCurrentMemberCount: async () => store.countAll("tenant-1"),
        getMaxSeats: async () => {
          if (!quotaAvailable) throw new Error("quota provider unavailable");
          return 1;
        },
      },
      idGenerator: () => "membership-1",
    });

    const original = await service.addMember("tenant-1", "user-1", "member", "add:user-1");
    quotaAvailable = false;
    const replay = await service.addMember("tenant-1", "user-1", "member", "add:user-1");

    expect(replay).toEqual(original);
    await expect(store.countAll("tenant-1")).resolves.toBe(1);
  });

  it("allows only one concurrent owner removal and exposes the stable Problem", async () => {
    const store = new InMemoryMembershipStore();
    await store.seed({ id: "owner-1", tenantId: "tenant-1", userId: "owner-1", role: "owner" });
    await store.seed({ id: "owner-2", tenantId: "tenant-1", userId: "owner-2", role: "owner" });
    const service = createService(store, async () => undefined);

    const results = await Promise.allSettled([
      service.removeMember("tenant-1", "owner-1", "remove:owner-1"),
      service.removeMember("tenant-1", "owner-2", "remove:owner-2"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.any(LastOwnerCannotBeRemovedProblem),
    });
    await expect(store.countByRole("tenant-1", "owner")).resolves.toBe(1);
  });

  it("allows only one concurrent owner demotion", async () => {
    const store = new InMemoryMembershipStore();
    await store.seed({ id: "owner-1", tenantId: "tenant-1", userId: "owner-1", role: "owner" });
    await store.seed({ id: "owner-2", tenantId: "tenant-1", userId: "owner-2", role: "owner" });
    const service = createService(store, async () => undefined);

    const results = await Promise.allSettled([
      service.updateRole("tenant-1", "owner-1", "admin", "demote:owner-1"),
      service.updateRole("tenant-1", "owner-2", "admin", "demote:owner-2"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.any(LastOwnerProblem),
    });
    await expect(store.countByRole("tenant-1", "owner")).resolves.toBe(1);
  });

  it("rejects a stale non-owner update after ownership transfers", async () => {
    class PausedCommandStore extends InMemoryMembershipStore {
      private release!: () => void;
      private reached!: () => void;
      readonly commandReached = new Promise<void>((resolve) => {
        this.reached = resolve;
      });
      private readonly barrier = new Promise<void>((resolve) => {
        this.release = resolve;
      });
      private pause = true;

      override async execute(command: MembershipCommand): Promise<MembershipCommandResult> {
        if (command.operation === "update_role" && this.pause) {
          this.pause = false;
          this.reached();
          await this.barrier;
        }
        return super.execute(command);
      }

      resume(): void {
        this.release();
      }
    }
    const store = new PausedCommandStore();
    await store.seed({ id: "owner", tenantId: "tenant-1", userId: "owner", role: "owner" });
    await store.seed({ id: "member", tenantId: "tenant-1", userId: "member", role: "member" });
    const service = createService(store, async () => undefined);

    const stale = service.updateRole("tenant-1", "member", "admin", "stale-update");
    await store.commandReached;
    await service.transferOwnership("tenant-1", "owner", "member", "transfer-before-update");
    store.resume();
    await expect(stale).rejects.toBeInstanceOf(LastOwnerProblem);
    await expect(store.findByTenantAndUser("tenant-1", "member")).resolves.toMatchObject({
      role: "owner",
    });
  });

  it("preserves role, seat-limit, and last-owner domain Problems", async () => {
    const store = new InMemoryMembershipStore();
    const service = new MembershipService({
      store,
      eventDelivery: "development",
      eventPublisher: { publishIdempotently: async () => undefined },
      seatLimitChecker: {
        checkSeatAvailability: async () => ({ usage: 1, quota: 1, exceeded: true, remaining: 0 }),
        getCurrentMemberCount: async () => 1,
        getMaxSeats: async () => 0,
      },
    });
    await expect(
      service.addMember("tenant-1", "user-1", "invalid" as never, "invalid-role"),
    ).rejects.toBeInstanceOf(InvalidRoleProblem);
    await expect(
      service.addMember("tenant-1", "user-1", "member", "seat-limit"),
    ).rejects.toBeInstanceOf(SeatLimitExceededProblem);

    await store.seed({ id: "owner", tenantId: "tenant-1", userId: "owner", role: "owner" });
    const unconstrained = createService(store, async () => undefined);
    await expect(
      unconstrained.removeMember("tenant-1", "owner", "remove-owner"),
    ).rejects.toBeInstanceOf(LastOwnerCannotBeRemovedProblem);
    await expect(
      unconstrained.updateRole("tenant-1", "owner", "member", "demote-owner"),
    ).rejects.toBeInstanceOf(LastOwnerProblem);
  });

  it("preserves ownership transfer validation Problems", async () => {
    const store = new InMemoryMembershipStore();
    const service = createService(store, async () => undefined);
    await store.seed({ id: "member", tenantId: "tenant-1", userId: "member", role: "member" });
    await store.seed({ id: "target", tenantId: "tenant-1", userId: "target", role: "member" });
    await expect(
      service.transferOwnership("tenant-1", "member", "target", "invalid-source"),
    ).rejects.toBeInstanceOf(OwnershipTransferRequiredProblem);
    await store.seed({ id: "owner", tenantId: "tenant-1", userId: "owner", role: "owner" });
    await expect(
      service.transferOwnership("tenant-1", "owner", "missing", "missing-target"),
    ).rejects.toBeInstanceOf(MembershipNotFoundProblem);
  });

  it("commits add with a recoverable intent independently of publication", async () => {
    const store = new InMemoryMembershipStore();
    const published: DomainEvent[] = [];
    let attempts = 0;
    const service = createService(store, async (event) => {
      attempts += 1;
      if (attempts === 1) throw new Error("transport failed");
      published.push(event);
    });

    await expect(
      service.addMember("tenant-1", "user-1", "member", "add:user-1"),
    ).resolves.toMatchObject({ id: "membership-1", role: "member" });
    expect(attempts).toBe(0);
    await expect(store.findByTenantAndUser("tenant-1", "user-1")).resolves.toMatchObject({
      id: "membership-1",
      role: "member",
    });
    await expect(store.getPendingEventIntent("add:user-1")).resolves.toMatchObject({
      idempotencyKey: "add:user-1",
    });

    await expect(service.publishPendingEvents()).rejects.toBeInstanceOf(
      MembershipEventPublicationProblem,
    );
    const replay = await service.addMember("tenant-1", "user-1", "member", "add:user-1");
    expect(replay.id).toBe("membership-1");
    await expect(service.publishPendingEvents()).resolves.toBe(1);
    expect(published).toHaveLength(1);
    expect(published[0]?.eventId).toMatch(/^[a-f0-9]{64}$/u);
    await expect(store.getPendingEventIntent("add:user-1")).resolves.toBeNull();
  });

  it("rejects semantic reuse of an idempotency key", async () => {
    const store = new InMemoryMembershipStore();
    const service = createService(store, async () => undefined);
    await service.addMember("tenant-1", "user-1", "member", "membership-command");

    await expect(
      service.addMember("tenant-1", "user-2", "member", "membership-command"),
    ).rejects.toBeInstanceOf(MembershipIdempotencyConflictProblem);
  });

  it("replays an update result while its original intent remains pending", async () => {
    const store = new InMemoryMembershipStore();
    await store.seed({
      id: "membership-1",
      tenantId: "tenant-1",
      userId: "user-1",
      role: "member",
    });
    let attempts = 0;
    const service = createService(store, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transport failed");
    });

    await expect(
      service.updateRole("tenant-1", "user-1", "admin", "promote:user-1"),
    ).resolves.toMatchObject({ role: "admin" });
    await expect(service.publishPendingEvents()).rejects.toBeInstanceOf(
      MembershipEventPublicationProblem,
    );
    await expect(
      service.updateRole("tenant-1", "user-1", "admin", "promote:user-1"),
    ).resolves.toMatchObject({ role: "admin" });
    await expect(service.publishPendingEvents()).resolves.toBe(1);
    expect(attempts).toBe(2);
  });

  it("keeps both ownership events in one intent and recovers partial publication", async () => {
    const store = new InMemoryMembershipStore();
    await store.seed({ id: "owner", tenantId: "tenant-1", userId: "owner", role: "owner" });
    await store.seed({ id: "member", tenantId: "tenant-1", userId: "member", role: "member" });
    const delivered = new Set<string>();
    let attempts = 0;
    const publish = vi.fn(async (event: DomainEvent) => {
      attempts += 1;
      if (attempts === 2) throw new Error("second event failed");
      delivered.add(event.eventId);
    });
    const service = createService(store, publish);

    await expect(
      service.transferOwnership("tenant-1", "owner", "member", "transfer-1"),
    ).resolves.toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
    await expect(service.publishPendingEvents()).rejects.toBeInstanceOf(
      MembershipEventPublicationProblem,
    );
    await expect(store.getPendingEventIntent("transfer-1")).resolves.toMatchObject({
      events: [{ eventName: "membership.updated" }, { eventName: "membership.updated" }],
    });

    const recovery = createService(store, async (event) => {
      delivered.add(event.eventId);
    });
    await expect(recovery.publishPendingEvents()).resolves.toBe(1);
    expect(delivered.size).toBe(2);
    await expect(store.findByTenantAndUser("tenant-1", "owner")).resolves.toMatchObject({
      role: "admin",
    });
    await expect(store.findByTenantAndUser("tenant-1", "member")).resolves.toMatchObject({
      role: "owner",
    });
  });
});
