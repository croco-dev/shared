import "reflect-metadata";
import {
  createOnboardingStoreConformanceSuite,
  type OnboardingState,
} from "@croco/onboarding-core";
import type { TxManager } from "@croco/tx-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DrizzleOnboardingClient } from "../libs/DrizzleOnboardingStore";
import { DrizzleOnboardingStore } from "../libs/DrizzleOnboardingStore";

describe("DrizzleOnboardingStore", () => {
  let store!: DrizzleOnboardingStore;
  let mockDb!: {
    select: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
  };
  let mockTxManager!: {
    getClient: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    const mockQueryBuilder = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
      values: vi.fn().mockReturnThis(),
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    };

    mockDb = {
      select: vi.fn().mockReturnValue(mockQueryBuilder),
      insert: vi.fn().mockReturnValue(mockQueryBuilder),
    };

    mockTxManager = {
      getClient: vi.fn().mockReturnValue(null),
      run: vi.fn(async (operation: () => Promise<unknown>) => operation()),
    };

    store = new DrizzleOnboardingStore(
      mockDb as unknown as DrizzleOnboardingClient,
      mockTxManager as unknown as TxManager<DrizzleOnboardingClient>,
    );
  });

  it("should return null when state not found", async () => {
    const state = await store.getState("tenant-1", "user-1", "onboarding-1");
    expect(state).toBeNull();
    expect(mockDb.select).toHaveBeenCalled();
  });

  it("should load every public lifecycle field", async () => {
    const startedAt = new Date("2026-08-20T00:00:00.000Z");
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([
            {
              steps: { "step-1": { completed: false } },
              isCompleted: false,
              completedAt: null,
              status: "in_progress",
              startedAt,
              currentStepId: "step-1",
            },
          ]),
        }),
      }),
    });

    await expect(store.getState("tenant-1", "user-1", "onboarding-1")).resolves.toEqual({
      steps: { "step-1": { completed: false } },
      isCompleted: false,
      completedAt: undefined,
      status: "in_progress",
      startedAt,
      currentStepId: "step-1",
    });
  });

  it("should save state using insert on conflict", async () => {
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    mockDb.insert.mockReturnValue({ values });
    const newState: OnboardingState = {
      steps: { "step-1": { completed: true } },
      isCompleted: false,
      completedAt: undefined,
      status: "in_progress",
      startedAt: new Date("2026-08-20T00:00:00.000Z"),
      currentStepId: "step-2",
    };

    await store.saveState("tenant-1", "user-1", "onboarding-1", newState);

    expect(mockDb.insert).toHaveBeenCalled();
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        completionStepId: null,
        status: newState.status,
        startedAt: newState.startedAt,
        currentStepId: newState.currentStepId,
      }),
    );
    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          status: newState.status,
          startedAt: newState.startedAt,
          currentStepId: newState.currentStepId,
        }),
      }),
    );
    expect(onConflictDoUpdate.mock.calls[0]?.[0].set).not.toHaveProperty("completionStepId");
  });

  it("should clear omitted lifecycle fields on update", async () => {
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    mockDb.insert.mockReturnValue({ values });

    await store.saveState("tenant-1", "user-1", "onboarding-1", {
      steps: {},
      isCompleted: false,
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ status: null, startedAt: null, currentStepId: null }),
    );
    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({ status: null, startedAt: null, currentStepId: null }),
      }),
    );
  });

  it("should preserve the completion step identity when updating state", async () => {
    let row: Record<string, unknown> = { completionStepId: "step-final" };
    const onConflictDoUpdate = vi.fn(async ({ set }: { set: Record<string, unknown> }) => {
      row = { ...row, ...set };
    });
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    mockDb.insert.mockReturnValue({ values });

    await store.saveState("tenant-1", "user-1", "onboarding-1", {
      steps: { "step-final": { completed: true } },
      isCompleted: true,
      completedAt: new Date("2026-08-20T01:00:00.000Z"),
    });

    expect(row.completionStepId).toBe("step-final");
  });

  it("should complete a step and its onboarding transition with one atomic upsert", async () => {
    const completedAt = new Date("2026-08-13T00:00:00.000Z");
    const returning = vi.fn().mockResolvedValue([
      {
        steps: { "step-1": { completed: true, completedAt } },
        isCompleted: true,
        completedAt,
        status: "in_progress",
        startedAt: new Date("2026-08-12T00:00:00.000Z"),
        currentStepId: "step-1",
        onboardingCompleted: true,
      },
    ]);
    const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
    const txClient = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate,
        }),
      }),
    };
    mockTxManager.getClient.mockReturnValue(txClient);

    const result = await store.completeStep("tenant-1", "user-1", "onboarding-1", {
      stepId: "step-1",
      completedAt,
      requiredStepIds: ["step-1"],
    });

    expect(result).toEqual({
      status: "completed",
      onboardingCompleted: true,
      state: {
        steps: { "step-1": { completed: true, completedAt } },
        isCompleted: true,
        completedAt,
        status: "in_progress",
        startedAt: new Date("2026-08-12T00:00:00.000Z"),
        currentStepId: "step-1",
      },
    });
    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ set: expect.any(Object), setWhere: expect.any(Object) }),
    );
    expect(mockTxManager.run).not.toHaveBeenCalled();
  });

  it("should return an idempotent result without rewriting an already completed step", async () => {
    const returning = vi.fn().mockResolvedValue([]);
    const txClient = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({ returning }),
        }),
      }),
    };
    mockTxManager.getClient.mockReturnValue(txClient);

    const result = await store.completeStep("tenant-1", "user-1", "onboarding-1", {
      stepId: "step-1",
      completedAt: new Date("2026-08-13T01:00:00.000Z"),
      requiredStepIds: ["step-1", "step-2"],
    });

    expect(result.status).toBe("already_completed");
  });

  it("should propagate transaction-fatal conflicts to the transaction owner", async () => {
    const transactionConflict = { code: "40001" };
    const txClient = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockRejectedValue(transactionConflict),
          }),
        }),
      }),
    };
    mockTxManager.getClient.mockReturnValue(txClient);

    await expect(
      store.completeStep("tenant-1", "user-1", "onboarding-1", {
        stepId: "step-1",
        completedAt: new Date("2026-08-13T00:00:00.000Z"),
        requiredStepIds: ["step-1"],
      }),
    ).rejects.toBe(transactionConflict);
  });
});

describe("DrizzleOnboardingStore conformance", () => {
  const conformance = createOnboardingStoreConformanceSuite({
    createStore: () => createStatefulStore(),
  });

  for (const testCase of conformance.cases) {
    // oxlint-disable-next-line jest/valid-title -- exported conformance cases own stable names
    it(testCase.name, testCase.run);
  }
});

function createStatefulStore(): DrizzleOnboardingStore {
  let row: Record<string, unknown> | undefined;
  const db = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn(async () => (row ? [row] : [])),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn((values: Record<string, unknown>) => ({
        onConflictDoUpdate: vi.fn(async ({ set }: { set: Record<string, unknown> }) => {
          row = row ? { ...row, ...set } : { ...values };
        }),
      })),
    }),
  };

  return new DrizzleOnboardingStore(
    db as unknown as DrizzleOnboardingClient,
    { getClient: vi.fn().mockReturnValue(null) } as unknown as TxManager<DrizzleOnboardingClient>,
  );
}
