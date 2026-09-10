import "reflect-metadata";
import { RoleHierarchyViolationProblem } from "@croco/membership-core";
import type {
  Membership,
  MembershipCreateInput,
  MembershipOwnerMutationInput,
  MembershipOwnershipTransferInput,
} from "@croco/membership-core";
import type { TxManager } from "@croco/tx-core";
import type { DrizzleDb } from "@croco/tx-drizzle";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  type DrizzleMembershipClient,
  DrizzleMembershipStore,
} from "../libs/DrizzleMembershipStore";

import { membershipIdempotencyRecords } from "../libs/schema";

const createInput = (overrides: Partial<MembershipCreateInput> = {}): MembershipCreateInput => {
  return {
    id: overrides.id ?? "mem-1",
    tenantId: overrides.tenantId ?? "tenant-1",
    userId: overrides.userId ?? "user-1",
    role: overrides.role ?? "member",
  };
};

const createMembership = (input: MembershipCreateInput): Membership => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: input.id,
    tenantId: input.tenantId,
    userId: input.userId,
    role: input.role,
    createdAt: now,
    updatedAt: now,
  };
};

class TestDrizzleMembershipStore extends DrizzleMembershipStore {
  seedMembership(input: MembershipCreateInput): Promise<Membership> {
    return this.save(input);
  }

  deleteFixtureMembership(tenantId: string, userId: string): Promise<void> {
    return this.delete(tenantId, userId);
  }

  mutateOwnerPrimitive(input: MembershipOwnerMutationInput) {
    return this.mutateOwner(input);
  }

  transferOwnershipPrimitive(input: MembershipOwnershipTransferInput) {
    return this.transferOwnership(input);
  }
}

type RawMembershipWrite = Extract<
  keyof DrizzleMembershipStore,
  "save" | "delete" | "mutateOwner" | "transferOwnership"
>;

describe("DrizzleMembershipStore", () => {
  let store!: TestDrizzleMembershipStore;

  let mockDb!: {
    execute: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    transaction?: ReturnType<typeof vi.fn>;
  };
  let mockTxManager!: {
    getClient: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockDb = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      update: vi.fn(),
      transaction: vi.fn(),
    };

    mockTxManager = {
      getClient: vi.fn().mockReturnValue(null),
      run: vi.fn(async (operation: () => Promise<unknown>) => operation()),
    };

    store = new TestDrizzleMembershipStore(
      mockDb as unknown as DrizzleMembershipClient,
      mockTxManager as unknown as TxManager<DrizzleMembershipClient>,
    );
  });

  it("exposes only command-based membership writes", () => {
    expectTypeOf<RawMembershipWrite>().toEqualTypeOf<never>();
  });

  it.each(["admin", "member", "viewer"] as const)(
    "rejects an update_role command promoting %s to owner without writes",
    async (role) => {
      const previous = createMembership(createInput({ role }));
      const limit = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([previous]);
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit }) }),
      });

      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ ...previous, role: "owner" }]),
          }),
        }),
      });

      await expect(
        store.execute({
          operation: "update_role",
          idempotencyKey: `promote:${role}`,
          tenantId: previous.tenantId,
          userId: previous.userId,
          role: "owner",
        }),
      ).rejects.toThrow(RoleHierarchyViolationProblem);

      expect(mockTxManager.run).toHaveBeenCalledTimes(1);
      expect(mockDb.insert).not.toHaveBeenCalled();
      expect(mockDb.update).not.toHaveBeenCalled();
      expect(mockDb.delete).not.toHaveBeenCalled();
    },
  );

  it("permits and replays an owner update_role no-op without membership or event writes", async () => {
    const owner = createMembership(createInput({ role: "owner" }));
    const limit = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([owner]);
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit }) }),
    });
    const values = vi.fn().mockResolvedValue(undefined);
    mockDb.insert.mockReturnValue({ values });
    const command = {
      operation: "update_role" as const,
      idempotencyKey: "owner:no-op",
      tenantId: owner.tenantId,
      userId: owner.userId,
      role: "owner" as const,
    };

    await expect(store.execute(command)).resolves.toEqual({
      operation: "update_role",
      membership: owner,
      previousRole: "owner",
      replayed: false,
    });
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    expect(mockDb.insert).toHaveBeenCalledWith(membershipIdempotencyRecords);
    limit.mockResolvedValueOnce([values.mock.calls[0]?.[0]]);

    await expect(store.execute(command)).resolves.toMatchObject({
      membership: owner,
      previousRole: "owner",
      replayed: true,
    });
    expect(limit).toHaveBeenCalledTimes(3);
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(mockDb.delete).not.toHaveBeenCalled();
  });

  it("should save and find membership by tenant and user", async () => {
    const input = createInput();
    const saved = createMembership(input);

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([saved]),
        }),
      }),
    });

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([saved]),
        }),
      }),
    });

    await store.seedMembership(input);
    const membership = await store.findByTenantAndUser("tenant-1", "user-1");

    expect(membership).not.toBeNull();
    expect(membership?.id).toBe("mem-1");
    expect(membership?.role).toBe("member");
  });

  it("should return all memberships by tenant", async () => {
    const rows = [
      createMembership(createInput({ id: "mem-1", tenantId: "tenant-1", userId: "user-1" })),
      createMembership(createInput({ id: "mem-2", tenantId: "tenant-1", userId: "user-2" })),
    ];

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
      }),
    });

    const memberships = await store.findAllByTenant("tenant-1");

    expect(memberships).toHaveLength(2);
    expect(memberships.map((membership) => membership.id).sort()).toEqual(["mem-1", "mem-2"]);
  });

  it("should return all memberships by user", async () => {
    const rows = [
      createMembership(createInput({ id: "mem-1", tenantId: "tenant-1", userId: "user-1" })),
      createMembership(createInput({ id: "mem-2", tenantId: "tenant-2", userId: "user-1" })),
    ];

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
      }),
    });

    const memberships = await store.findAllByUser("user-1");

    expect(memberships).toHaveLength(2);
    expect(memberships.map((membership) => membership.id).sort()).toEqual(["mem-1", "mem-2"]);
  });

  it("should delete membership", async () => {
    mockDb.delete.mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });

    await expect(store.deleteFixtureMembership("tenant-1", "user-1")).resolves.toBeUndefined();
    expect(mockDb.delete).toHaveBeenCalled();
  });

  it("should count memberships by role in tenant", async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ total: 2 }]),
      }),
    });

    const count = await store.countByRole("tenant-1", "admin");

    expect(count).toBe(2);
  });

  it("should serialize owner removal in a transaction before applying it", async () => {
    const owner = createMembership(createInput({ role: "owner" }));
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          for: vi.fn().mockResolvedValue([{ userId: "user-1" }]),
        }),
      }),
    });
    mockDb.delete.mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([owner]),
      }),
    });

    const result = await store.mutateOwnerPrimitive({
      tenantId: "tenant-1",
      userId: "user-1",
      operation: "remove",
    });

    expect(result).toMatchObject({ status: "applied", membership: { role: "owner" } });
    expect(mockTxManager.run).toHaveBeenCalledTimes(1);
    expect(mockDb.select.mock.invocationCallOrder[0]).toBeLessThan(
      mockDb.delete.mock.invocationCallOrder[0],
    );
  });

  it("should keep the last owner when the conditional delete rejects the transition", async () => {
    const owner = createMembership(createInput({ role: "owner" }));
    mockDb.delete.mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    });
    mockDb.select
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            for: vi.fn().mockResolvedValue([{ userId: "user-1" }]),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([owner]),
          }),
        }),
      });

    await expect(
      store.mutateOwnerPrimitive({
        tenantId: "tenant-1",
        userId: "user-1",
        operation: "remove",
      }),
    ).resolves.toEqual({ status: "last_owner" });
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("should demote an owner with one conditional update", async () => {
    const admin = createMembership(createInput({ role: "admin" }));
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          for: vi.fn().mockResolvedValue([{ userId: "user-1" }]),
        }),
      }),
    });
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([admin]),
        }),
      }),
    });

    await expect(
      store.mutateOwnerPrimitive({
        tenantId: "tenant-1",
        userId: "user-1",
        operation: "demote",
        role: "admin",
      }),
    ).resolves.toMatchObject({ status: "applied", membership: { role: "admin" } });
    expect(mockTxManager.run).toHaveBeenCalledTimes(1);
  });

  it("should preserve one owner when row locks are reentrant in a shared transaction", async () => {
    const owner = createMembership(createInput({ role: "owner" }));
    let arrived = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let selectCalls = 0;
    mockDb.select.mockImplementation(() => {
      selectCalls += 1;
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(
            selectCalls <= 2
              ? {
                  for: vi.fn().mockImplementation(async () => {
                    arrived += 1;
                    if (arrived === 2) {
                      releaseBarrier();
                    }
                    await barrier;
                    return [{ userId: "user-1" }, { userId: "user-2" }];
                  }),
                }
              : {
                  limit: vi.fn().mockResolvedValue([owner]),
                },
          ),
        }),
      };
    });

    let mutation = 0;
    mockDb.delete.mockImplementation(() => ({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockImplementation(async () => {
          mutation += 1;
          return mutation === 1 ? [owner] : [];
        }),
      }),
    }));
    const results = await Promise.allSettled([
      store.mutateOwnerPrimitive({ tenantId: "tenant-1", userId: "user-1", operation: "remove" }),
      store.mutateOwnerPrimitive({ tenantId: "tenant-1", userId: "user-2", operation: "remove" }),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ status: "fulfilled" }),
      expect.objectContaining({ status: "fulfilled" }),
    ]);
    expect(
      results
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value.status)
        .sort(),
    ).toEqual(["applied", "last_owner"]);
    expect(mockDb.delete).toHaveBeenCalledTimes(2);
  });

  it("should expose repeatable-read serialization failures as a stable conflict result", async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          for: vi.fn().mockRejectedValue({ code: "40001" }),
        }),
      }),
    });

    await expect(
      store.mutateOwnerPrimitive({
        tenantId: "tenant-1",
        userId: "user-1",
        operation: "remove",
      }),
    ).resolves.toEqual({ status: "conflict" });
    expect(mockDb.delete).not.toHaveBeenCalled();
  });

  it("should transfer ownership with one update statement", async () => {
    const fromOwner = createMembership(
      createInput({ id: "mem-1", userId: "user-1", role: "owner" }),
    );
    const toAdmin = createMembership(createInput({ id: "mem-2", userId: "user-2", role: "admin" }));
    const updatedFrom = { ...fromOwner, role: "admin" as const };
    const updatedTo = { ...toAdmin, role: "owner" as const };
    mockDb.select
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            for: vi.fn().mockResolvedValue([{ userId: "user-1" }]),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([fromOwner, toAdmin]),
        }),
      });
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([updatedFrom, updatedTo]),
        }),
      }),
    });

    await expect(
      store.transferOwnershipPrimitive({
        tenantId: "tenant-1",
        fromUserId: "user-1",
        toUserId: "user-2",
      }),
    ).resolves.toMatchObject({
      status: "applied",
      fromMembership: { role: "admin" },
      toMembership: { role: "owner" },
      previousToRole: "admin",
    });
    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.delete).not.toHaveBeenCalled();
  });

  it("should update membership when saving same tenant and user", async () => {
    const initial = createMembership(createInput({ id: "mem-1", role: "member" }));
    const updated = createMembership(createInput({ id: "mem-1", role: "admin" }));

    mockDb.insert
      .mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([initial]),
          }),
        }),
      })
      .mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated]),
          }),
        }),
      });

    const first = await store.seedMembership(createInput({ id: "mem-1", role: "member" }));
    const next = await store.seedMembership(createInput({ id: "mem-1", role: "admin" }));

    expect(first.role).toBe("member");
    expect(next.role).toBe("admin");
  });
});
