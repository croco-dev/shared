import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MeterRepository } from "../libs/MeterRepository";
import type { MeterDefinition, UsageRecord } from "../libs/types";
import { UsageAggregator } from "../libs/UsageAggregator";
import type { UsageStorage } from "../libs/UsageStorage";

describe("UsageAggregator", () => {
  let aggregator!: UsageAggregator;
  let mockStorage!: UsageStorage;
  let mockRepository!: MeterRepository;

  const createMeter = (overrides: Partial<MeterDefinition> = {}): MeterDefinition => ({
    id: "meter-123",
    tenantId: "tenant-1",
    meterId: "api_calls",
    type: "COUNT",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  const createUsageRecord = (overrides: Partial<UsageRecord> = {}): UsageRecord => ({
    id: "usage-123",
    tenantId: "tenant-1",
    meterId: "api_calls",
    value: 5,
    timestamp: new Date(),
    idempotencyKey: "key-123",
    ...overrides,
  });

  beforeEach(() => {
    mockStorage = {
      replayContract: "idempotent",
      deleteUsageRecords: vi.fn().mockResolvedValue(undefined),
      record: vi.fn().mockResolvedValue(undefined),
      getUsage: vi.fn().mockResolvedValue(0),
      isIdempotent: vi.fn().mockResolvedValue(true),
      fetchUsageRecords: vi.fn().mockResolvedValue([]),
      checkAndRecordWithinQuota: vi.fn().mockResolvedValue({ exceeded: false, newUsage: 0 }),
    };

    mockRepository = {
      replayContract: "idempotent",
      findByMeterIdAndTenant: vi.fn(),
      save: vi.fn(),
      findAll: vi.fn(),
      findByTenant: vi.fn().mockResolvedValue([]),
      saveUsageRecords: vi.fn().mockResolvedValue(undefined),
    };

    aggregator = new UsageAggregator({
      usageStorage: mockStorage,
      meterRepository: mockRepository,
    });
  });

  it("should reject storage without deletion before any persistence", () => {
    delete mockStorage.deleteUsageRecords;
    expect(
      () => new UsageAggregator({ usageStorage: mockStorage, meterRepository: mockRepository }),
    ).toThrow("deleteUsageRecords");
    expect(mockStorage.fetchUsageRecords).not.toHaveBeenCalled();
    expect(mockRepository.saveUsageRecords).not.toHaveBeenCalled();
  });

  it("should reject repositories without an idempotent replay contract", () => {
    const { replayContract: _contract, ...legacyRepository } = mockRepository;
    expect(
      () =>
        new UsageAggregator({
          usageStorage: mockStorage,
          meterRepository: legacyRepository as MeterRepository,
        }),
    ).toThrow("idempotent");
    expect(mockStorage.fetchUsageRecords).not.toHaveBeenCalled();
    expect(mockRepository.saveUsageRecords).not.toHaveBeenCalled();
  });

  describe("flushUsageToDB", () => {
    it("should fetch records from storage and save to repository", async () => {
      const records = [
        createUsageRecord({ id: "usage-1", value: 5 }),
        createUsageRecord({ id: "usage-2", value: 3 }),
      ];
      vi.mocked(mockStorage.fetchUsageRecords).mockResolvedValue(records);

      const result = await aggregator.flushUsageToDB("tenant-1", "api_calls");

      expect(result.recordsFlushed).toBe(2);
      expect(mockStorage.fetchUsageRecords).toHaveBeenCalledWith({
        tenantId: "tenant-1",
        meterId: "api_calls",
        period: "billing_cycle",
      });
      expect(mockRepository.saveUsageRecords).toHaveBeenCalledWith(records);
    });

    it("should delete records from storage only after successful save", async () => {
      const records = [
        createUsageRecord({ id: "usage-1", value: 5 }),
        createUsageRecord({ id: "usage-2", value: 3 }),
      ];
      const callOrder: Array<"fetch" | "save" | "delete"> = [];

      vi.mocked(mockStorage.fetchUsageRecords).mockImplementation(async () => {
        callOrder.push("fetch");
        return records;
      });

      vi.mocked(mockRepository.saveUsageRecords).mockImplementation(async () => {
        callOrder.push("save");
      });

      const deleteUsageRecords = vi.fn().mockImplementation(async () => {
        callOrder.push("delete");
      });
      mockStorage.deleteUsageRecords = deleteUsageRecords;

      await aggregator.flushUsageToDB("tenant-1", "api_calls");

      expect(deleteUsageRecords).toHaveBeenCalledWith(
        {
          tenantId: "tenant-1",
          meterId: "api_calls",
          period: "billing_cycle",
        },
        records,
      );
      expect(callOrder).toEqual(["fetch", "save", "delete"]);
    });

    it("should remove flushed records from subsequent flushes", async () => {
      const pendingRecords = [
        createUsageRecord({ id: "usage-1", value: 5 }),
        createUsageRecord({ id: "usage-2", value: 3 }),
      ];

      vi.mocked(mockStorage.fetchUsageRecords).mockImplementation(async () => [...pendingRecords]);
      mockStorage.deleteUsageRecords = vi
        .fn()
        .mockImplementation(async (_options, flushedRecords: UsageRecord[]) => {
          const flushedIds = new Set(flushedRecords.map((record) => record.id));
          const remaining = pendingRecords.filter((record) => !flushedIds.has(record.id));
          pendingRecords.splice(0, pendingRecords.length, ...remaining);
        });

      const first = await aggregator.flushUsageToDB("tenant-1", "api_calls");
      const second = await aggregator.flushUsageToDB("tenant-1", "api_calls");

      expect(first.recordsFlushed).toBe(2);
      expect(second.recordsFlushed).toBe(0);
      expect(mockRepository.saveUsageRecords).toHaveBeenCalledTimes(1);
    });

    it("should keep records in storage when save fails", async () => {
      const records = [createUsageRecord({ id: "usage-1", value: 5 })];
      vi.mocked(mockStorage.fetchUsageRecords).mockResolvedValue(records);

      const deleteUsageRecords = vi.fn().mockResolvedValue(undefined);
      mockStorage.deleteUsageRecords = deleteUsageRecords;

      vi.mocked(mockRepository.saveUsageRecords).mockRejectedValue(new Error("DB save failed"));

      await expect(aggregator.flushUsageToDB("tenant-1", "api_calls")).rejects.toThrow(
        "DB save failed",
      );
      expect(deleteUsageRecords).not.toHaveBeenCalled();
    });

    it("should return 0 when no records to flush", async () => {
      vi.mocked(mockStorage.fetchUsageRecords).mockResolvedValue([]);

      const result = await aggregator.flushUsageToDB("tenant-1", "api_calls");

      expect(result.recordsFlushed).toBe(0);
      expect(mockRepository.saveUsageRecords).not.toHaveBeenCalled();
    });

    it("should use provided period", async () => {
      vi.mocked(mockStorage.fetchUsageRecords).mockResolvedValue([]);

      await aggregator.flushUsageToDB("tenant-1", "api_calls", "day");

      expect(mockStorage.fetchUsageRecords).toHaveBeenCalledWith({
        tenantId: "tenant-1",
        meterId: "api_calls",
        period: "day",
      });
    });

    it("should handle large batch of records", async () => {
      const records = Array.from({ length: 1000 }, (_, i) =>
        createUsageRecord({ id: `usage-${i}`, value: 1 }),
      );
      vi.mocked(mockStorage.fetchUsageRecords).mockResolvedValue(records);

      const result = await aggregator.flushUsageToDB("tenant-1", "api_calls");

      expect(result.recordsFlushed).toBe(1000);
    });
  });

  describe("flushAllForTenant", () => {
    it("should flush all meters for tenant", async () => {
      const meters = [
        createMeter({ meterId: "api_calls" }),
        createMeter({ meterId: "storage" }),
        createMeter({ meterId: "bandwidth" }),
      ];
      vi.mocked(mockRepository.findByTenant).mockResolvedValue(meters);
      vi.mocked(mockStorage.fetchUsageRecords)
        .mockResolvedValueOnce([createUsageRecord({ value: 5 })])
        .mockResolvedValueOnce([createUsageRecord({ value: 3 })])
        .mockResolvedValueOnce([createUsageRecord({ value: 2 })]);

      const result = await aggregator.flushAllForTenant("tenant-1");

      expect(result.recordsFlushed).toBe(3);
      expect(mockStorage.fetchUsageRecords).toHaveBeenCalledTimes(3);
    });

    it("should return 0 when tenant has no meters", async () => {
      vi.mocked(mockRepository.findByTenant).mockResolvedValue([]);

      const result = await aggregator.flushAllForTenant("tenant-1");

      expect(result.recordsFlushed).toBe(0);
    });

    it("should handle mixed results", async () => {
      const meters = [createMeter({ meterId: "api_calls" }), createMeter({ meterId: "storage" })];
      vi.mocked(mockRepository.findByTenant).mockResolvedValue(meters);
      vi.mocked(mockStorage.fetchUsageRecords)
        .mockResolvedValueOnce([createUsageRecord(), createUsageRecord()])
        .mockResolvedValueOnce([]);

      const result = await aggregator.flushAllForTenant("tenant-1");

      expect(result.recordsFlushed).toBe(2);
    });
  });

  describe("getAggregatedUsage", () => {
    it("should return usage from storage", async () => {
      vi.mocked(mockStorage.getUsage).mockResolvedValue(150);

      const result = await aggregator.getAggregatedUsage({
        tenantId: "tenant-1",
        meterId: "api_calls",
        period: "billing_cycle",
      });

      expect(result).toBe(150);
    });

    it("should pass all options to storage", async () => {
      const startDate = new Date("2024-01-01");
      const endDate = new Date("2024-01-31");

      await aggregator.getAggregatedUsage({
        tenantId: "tenant-1",
        meterId: "api_calls",
        period: "day",
        startDate,
        endDate,
      });

      expect(mockStorage.getUsage).toHaveBeenCalledWith({
        tenantId: "tenant-1",
        meterId: "api_calls",
        period: "day",
        startDate,
        endDate,
      });
    });
  });
});
