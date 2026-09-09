import {
  type AtomicQuotaCheckOptions,
  type AtomicQuotaCheckResult,
  IdempotencyManager,
  type MeterDefinition,
  MeteringService,
  type MeterRegistrationOptions,
  MeterRegistry,
  MeterRepository,
  type RedisClient,
  RedisProblem,
  type UsageQueryOptions,
  type UsageRecord,
  type UsageStorage,
} from "@croco/metering-core";

class InMemoryUsageStorage implements UsageStorage {
  readonly replayContract = "idempotent" as const;

  private records: UsageRecord[] = [];
  private readonly idempotencyKeys = new Set<string>();
  private readonly recordedKeys = new Set<string>();
  private readonly quotaResults = new Map<string, AtomicQuotaCheckResult>();

  async record(usage: UsageRecord): Promise<void> {
    const key = this.buildIdempotencyKey(usage.tenantId, usage.meterId, usage.idempotencyKey);
    if (this.recordedKeys.has(key)) {
      return;
    }

    this.recordedKeys.add(key);
    this.records = [...this.records, usage];
    console.log("usage recorded", usage);
  }

  async getUsage(options: UsageQueryOptions): Promise<number> {
    return this.filterRecords(options).reduce((total, record) => total + record.value, 0);
  }

  async isIdempotent(
    tenantId: string,
    meterId: string,
    idempotencyKey: string,
    _ttlSeconds: number,
  ): Promise<boolean> {
    const key = this.buildIdempotencyKey(tenantId, meterId, idempotencyKey);
    if (this.idempotencyKeys.has(key)) {
      return false;
    }

    this.idempotencyKeys.add(key);
    return true;
  }

  async fetchUsageRecords(options: UsageQueryOptions): Promise<UsageRecord[]> {
    return this.filterRecords(options);
  }

  async checkAndRecordWithinQuota(
    options: AtomicQuotaCheckOptions,
  ): Promise<AtomicQuotaCheckResult> {
    const key = this.buildIdempotencyKey(
      options.tenantId,
      options.meterId,
      options.usageRecord.idempotencyKey,
    );
    const recordedResult = this.quotaResults.get(key);
    if (recordedResult) {
      return recordedResult;
    }

    const currentUsage = await this.getUsage({
      tenantId: options.tenantId,
      meterId: options.meterId,
      period: "billing_cycle",
    });
    const newUsage = currentUsage + options.value;
    const exceeded = newUsage > options.quota;
    if (!exceeded || options.allowOverQuota) {
      await this.record(options.usageRecord);
    }

    const result = { exceeded, newUsage };
    this.quotaResults.set(key, result);
    return result;
  }

  private filterRecords(options: UsageQueryOptions): UsageRecord[] {
    return this.records.filter((record) => {
      const startsAfter = !options.startDate || record.timestamp >= options.startDate;
      const endsBefore = !options.endDate || record.timestamp <= options.endDate;
      return (
        record.tenantId === options.tenantId &&
        record.meterId === options.meterId &&
        startsAfter &&
        endsBefore
      );
    });
  }

  private buildIdempotencyKey(tenantId: string, meterId: string, idempotencyKey: string): string {
    return `${tenantId}:${meterId}:${idempotencyKey}`;
  }
}

type InMemoryMeteringDeliveryState = {
  status: "PROCESSING" | "PUBLISHING" | "EVENTS_PENDING" | "COMPLETED";
  token?: string;
  leaseExpiresAt?: number;
  operationId?: string;
  delivery?: string;
};

export class InMemoryRedisClient implements RedisClient {
  readonly scriptKeyAccess = "multi-key" as const;

  private readonly values = new Map<string, string>();

  async zadd(): Promise<number> {
    return 1;
  }

  async zrangebyscore(): Promise<string[]> {
    return [];
  }

  async set(
    key: string,
    value: string,
    _mode: "NX",
    _expireMode: "EX",
    _expire: number,
  ): Promise<string | null> {
    if (this.values.has(key)) {
      return null;
    }

    this.values.set(key, value);
    return "OK";
  }

  async eval<TResult extends unknown[]>(
    script: string,
    keys: string[],
    args: Array<string | number>,
  ): Promise<TResult> {
    const key = keys[0];

    if (script.includes("state.status == 'EVENTS_PENDING'")) {
      return this.claimMeteringDelivery(keys, args) as unknown as TResult;
    }

    if (script.includes("state.delivery = ARGV[2]")) {
      return this.markMeteringDeliveryPublishing(key, args) as unknown as TResult;
    }

    if (script.includes("state.leaseExpiresAt = 0")) {
      return this.releaseMeteringProcessing(key, args) as unknown as TResult;
    }

    if (script.includes("state.status = 'EVENTS_PENDING'")) {
      return this.releaseMeteringDelivery(key, args) as unknown as TResult;
    }

    if (script.includes('{"status":"COMPLETED"}')) {
      return this.completeMeteringDelivery(keys, args) as unknown as TResult;
    }

    if (script.includes("redis.call('DEL', KEYS[2])")) {
      return this.abortMeteringDelivery(keys, args) as unknown as TResult;
    }

    if (script.includes("EXISTS")) {
      if (this.values.has(key)) {
        return [0] as TResult;
      }

      this.values.set(key, String(args[0]));
      return [1] as TResult;
    }

    if (script.includes("GET") && script.includes("SET")) {
      if (this.values.get(key) === String(args[0])) {
        this.values.set(key, String(args[1]));
      }
      return [1] as TResult;
    }

    if (script.includes("GET") && script.includes("DEL")) {
      if (this.values.get(key) === String(args[0])) {
        this.values.delete(key);
      }
      return [1] as TResult;
    }

    throw new RedisProblem("EVAL", "Unsupported in-memory Redis script");
  }

  private claimMeteringDelivery(
    keys: string[],
    args: Array<string | number>,
  ): [number, string, string] {
    const [deliveryKey, legacyKey] = keys;
    const [
      token,
      leaseMilliseconds,
      ,
      operationId,
      inProgressStatusPrefix,
      completedStatus,
      leaseValue,
    ] = args;
    const existingState = this.readDeliveryState(deliveryKey);
    const now = Date.now();

    if (!existingState) {
      const legacyStatus = this.values.get(legacyKey);
      if (
        legacyStatus?.startsWith(String(inProgressStatusPrefix)) ||
        legacyStatus === String(completedStatus)
      ) {
        return [0, "", ""];
      }

      const newOperationId = String(operationId);
      const state: InMemoryMeteringDeliveryState = {
        status: "PROCESSING",
        token: String(token),
        leaseExpiresAt: now + Number(leaseMilliseconds),
        operationId: newOperationId,
      };
      this.values.set(deliveryKey, JSON.stringify(state));
      if (!legacyStatus) {
        this.values.set(legacyKey, String(leaseValue));
      }
      return [1, "", newOperationId];
    }

    const leaseExpired =
      (existingState.status === "PROCESSING" || existingState.status === "PUBLISHING") &&
      (existingState.leaseExpiresAt ?? 0) <= now;
    if (existingState.status !== "EVENTS_PENDING" && !leaseExpired) {
      return [0, "", ""];
    }

    existingState.status = existingState.delivery ? "PUBLISHING" : "PROCESSING";
    existingState.token = String(token);
    const claimedOperationId = existingState.operationId ?? String(operationId);
    existingState.operationId = claimedOperationId;
    existingState.leaseExpiresAt = now + Number(leaseMilliseconds);
    this.values.set(deliveryKey, JSON.stringify(existingState));
    this.values.set(legacyKey, String(leaseValue));
    return [1, existingState.delivery ?? "", claimedOperationId];
  }

  private markMeteringDeliveryPublishing(key: string, args: Array<string | number>): [number] {
    const [token, deliveryJson, leaseMilliseconds] = args;
    const state = this.readDeliveryState(key);
    if (!state || state.status !== "PROCESSING" || state.token !== String(token)) {
      return [0];
    }

    state.status = "PUBLISHING";
    state.delivery = String(deliveryJson);
    state.leaseExpiresAt = Date.now() + Number(leaseMilliseconds);
    this.values.set(key, JSON.stringify(state));
    return [1];
  }

  private releaseMeteringDelivery(key: string, args: Array<string | number>): [number] {
    const state = this.readDeliveryState(key);
    if (state?.status !== "PUBLISHING" || state.token !== String(args[0])) {
      return [0];
    }

    state.status = "EVENTS_PENDING";
    delete state.token;
    delete state.leaseExpiresAt;
    this.values.set(key, JSON.stringify(state));
    return [1];
  }

  private releaseMeteringProcessing(key: string, args: Array<string | number>): [number] {
    const state = this.readDeliveryState(key);
    if (state?.status !== "PROCESSING" || state.token !== String(args[0])) {
      return [0];
    }

    delete state.token;
    state.leaseExpiresAt = 0;
    this.values.set(key, JSON.stringify(state));
    return [1];
  }

  private completeMeteringDelivery(keys: string[], args: Array<string | number>): [number] {
    const [deliveryKey, legacyKey] = keys;
    const [token, , completedStatus] = args;
    const state = this.readDeliveryState(deliveryKey);
    if (!state || state.status !== "PUBLISHING" || state.token !== String(token)) {
      return [0];
    }

    this.values.set(deliveryKey, JSON.stringify({ status: "COMPLETED" }));
    this.values.set(legacyKey, String(completedStatus));
    return [1];
  }

  private abortMeteringDelivery(keys: string[], args: Array<string | number>): [number] {
    const [deliveryKey, legacyKey] = keys;
    const [token, inProgressStatus] = args;
    const state = this.readDeliveryState(deliveryKey);
    if (
      state?.status !== "PROCESSING" ||
      state.token !== String(token) ||
      this.values.get(legacyKey) !== String(inProgressStatus)
    ) {
      return [0];
    }

    this.values.delete(deliveryKey);
    this.values.delete(legacyKey);
    return [1];
  }

  private readDeliveryState(key: string): InMemoryMeteringDeliveryState | undefined {
    const value = this.values.get(key);
    return value ? (JSON.parse(value) as InMemoryMeteringDeliveryState) : undefined;
  }
}

class InMemoryMeterRepository extends MeterRepository {
  readonly replayContract = "idempotent" as const;
  private readonly usageRecords: UsageRecord[] = [];

  private meters: MeterDefinition[] = [
    {
      id: "meter-api-user-create",
      tenantId: "default",
      meterId: "api_user_create",
      type: "COUNT",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  async findByMeterIdAndTenant(meterId: string, tenantId: string): Promise<MeterDefinition | null> {
    return (
      this.meters.find((meter) => meter.meterId === meterId && meter.tenantId === tenantId) ?? null
    );
  }

  async save(meter: MeterRegistrationOptions): Promise<MeterDefinition> {
    const saved = {
      id: `meter-${this.meters.length + 1}`,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...meter,
    };
    this.meters = [...this.meters, saved];
    return saved;
  }

  async findAll(): Promise<MeterDefinition[]> {
    return [...this.meters];
  }

  async findByTenant(tenantId: string): Promise<MeterDefinition[]> {
    return this.meters.filter((meter) => meter.tenantId === tenantId);
  }

  async saveUsageRecords(records: UsageRecord[]): Promise<void> {
    for (const record of records) {
      const persisted = this.usageRecords.some(
        (existing) =>
          existing.tenantId === record.tenantId &&
          existing.meterId === record.meterId &&
          existing.idempotencyKey === record.idempotencyKey,
      );
      if (!persisted) {
        this.usageRecords.push(record);
      }
    }
  }
}

export function createMeteringService(): MeteringService {
  const usageStorage = new InMemoryUsageStorage();
  const meterRegistry = new MeterRegistry(new InMemoryMeterRepository());
  const idempotencyManager = new IdempotencyManager(new InMemoryRedisClient());

  return new MeteringService({
    meterRegistry,
    usageStorage,
    idempotencyManager,
  });
}
