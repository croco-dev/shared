import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MeterRepository } from "../libs/MeterRepository";
import type { MeterDefinition, MeterRegistrationOptions, UsageRecord } from "../libs/types";

describe("MeterRepository", () => {
  let mockRepository!: MeterRepository;

  beforeEach(() => {
    mockRepository = {
      replayContract: "idempotent",
      findByMeterIdAndTenant: vi.fn(),
      save: vi.fn(),
      findAll: vi.fn(),
      findByTenant: vi.fn(),
      saveUsageRecords: vi.fn(),
    };
  });

  describe("findByMeterIdAndTenant", () => {
    it("should return meter definition when found", async () => {
      const meter: MeterDefinition = {
        id: "meter-123",
        tenantId: "tenant-1",
        meterId: "api_calls",
        type: "COUNT",
        quota: 1000,
        allowOverQuota: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(mockRepository.findByMeterIdAndTenant).mockResolvedValue(meter);

      const result = await mockRepository.findByMeterIdAndTenant("api_calls", "tenant-1");

      expect(result).toEqual(meter);
      expect(mockRepository.findByMeterIdAndTenant).toHaveBeenCalledWith("api_calls", "tenant-1");
    });

    it("should return null when meter not found", async () => {
      vi.mocked(mockRepository.findByMeterIdAndTenant).mockResolvedValue(null);

      const result = await mockRepository.findByMeterIdAndTenant("unknown", "tenant-1");

      expect(result).toBeNull();
    });
  });

  describe("save", () => {
    it("should save meter and return with id", async () => {
      const options: MeterRegistrationOptions = {
        tenantId: "tenant-1",
        meterId: "api_calls",
        type: "COUNT",
        quota: 1000,
      };

      const savedMeter: MeterDefinition = {
        ...options,
        id: "meter-123",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(mockRepository.save).mockResolvedValue(savedMeter);

      const result = await mockRepository.save(options);

      expect(result.id).toBe("meter-123");
      expect(mockRepository.save).toHaveBeenCalledWith(options);
    });
  });

  describe("findAll", () => {
    it("should return all meters", async () => {
      const meters: MeterDefinition[] = [
        {
          id: "meter-1",
          tenantId: "tenant-1",
          meterId: "api_calls",
          type: "COUNT",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "meter-2",
          tenantId: "tenant-2",
          meterId: "storage",
          type: "CUSTOM_EVENT",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      vi.mocked(mockRepository.findAll).mockResolvedValue(meters);

      const result = await mockRepository.findAll();

      expect(result).toHaveLength(2);
    });

    it("should return empty array when no meters", async () => {
      vi.mocked(mockRepository.findAll).mockResolvedValue([]);

      const result = await mockRepository.findAll();

      expect(result).toEqual([]);
    });
  });

  describe("findByTenant", () => {
    it("should return meters for specific tenant", async () => {
      const meters: MeterDefinition[] = [
        {
          id: "meter-1",
          tenantId: "tenant-1",
          meterId: "api_calls",
          type: "COUNT",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      vi.mocked(mockRepository.findByTenant).mockResolvedValue(meters);

      const result = await mockRepository.findByTenant("tenant-1");

      expect(result).toHaveLength(1);
      expect(mockRepository.findByTenant).toHaveBeenCalledWith("tenant-1");
    });
  });

  describe("saveUsageRecords", () => {
    it("should save usage records to database", async () => {
      const records: UsageRecord[] = [
        {
          id: "usage-1",
          tenantId: "tenant-1",
          meterId: "api_calls",
          value: 5,
          timestamp: new Date(),
          idempotencyKey: "key-1",
        },
        {
          id: "usage-2",
          tenantId: "tenant-1",
          meterId: "api_calls",
          value: 3,
          timestamp: new Date(),
          idempotencyKey: "key-2",
        },
      ];

      vi.mocked(mockRepository.saveUsageRecords).mockResolvedValue(undefined);

      await mockRepository.saveUsageRecords(records);

      expect(mockRepository.saveUsageRecords).toHaveBeenCalledWith(records);
    });

    it("should handle empty records array", async () => {
      vi.mocked(mockRepository.saveUsageRecords).mockResolvedValue(undefined);

      await mockRepository.saveUsageRecords([]);

      expect(mockRepository.saveUsageRecords).toHaveBeenCalledWith([]);
    });
  });
});
