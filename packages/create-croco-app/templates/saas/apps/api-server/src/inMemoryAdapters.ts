import type {
  AccessProvider,
  CheckRequest,
  CheckResult,
  GrantRequest,
  ListRequest,
  RelationTuple,
  RevokeRequest,
} from "@croco/access-core";
import type { DomainEvent, EventBus, EventSubscription } from "@croco/events-core";
import type {
  CreateExecutionParams,
  Execution,
  ExecutionLogEntry,
  ExecutionLogStore,
  ExecutionStore,
  ListExecutionsOptions,
} from "@croco/execution-core";
import { ExecutionProblems, prepareExecutionCheckpoint } from "@croco/execution-core";
import {
  type AtomicQuotaCheckOptions,
  type AtomicQuotaCheckResult,
  type MeterDefinition,
  type MeterRegistrationOptions,
  MeterRepository,
  type RedisClient,
  RedisProblem,
  type UsageQueryOptions,
  type UsageRecord,
  type UsageStorage,
} from "@croco/metering-core";
import type { Tenant, TenantFilter, TenantSettings, TenantStore } from "@croco/tenant-core";
import type { TxAdapter } from "@croco/tx-core";
import { TenantAlreadyExistsProblem, TenantNotFoundProblem } from "./problems";

function createTenantId(slug: string): string {
  return `tenant_${slug.replace(/[^a-z0-9_-]/g, "_")}`;
}

function relationKey(tenantId: string, tuple: RelationTuple): string {
  return `${tenantId}:${tuple.object}:${tuple.relation}:${tuple.subject}`;
}

function isWithinRange(record: UsageRecord, options: UsageQueryOptions): boolean {
  if (record.tenantId !== options.tenantId || record.meterId !== options.meterId) {
    return false;
  }
  if (options.startDate && record.timestamp < options.startDate) {
    return false;
  }
  if (options.endDate && record.timestamp > options.endDate) {
    return false;
  }
  return true;
}

export class InMemoryTenantStore implements TenantStore {
  private readonly tenants = new Map<string, Tenant>();

  async findById(id: string): Promise<Tenant | null> {
    return this.tenants.get(id) ?? null;
  }

  async findBySlug(slug: string): Promise<Tenant | null> {
    return [...this.tenants.values()].find((tenant) => tenant.slug === slug) ?? null;
  }

  async findAll(filter: TenantFilter = {}): Promise<Tenant[]> {
    return [...this.tenants.values()].filter((tenant) => {
      if (filter.status && tenant.status !== filter.status) return false;
      if (filter.slug && tenant.slug !== filter.slug) return false;
      if (filter.search && !tenant.name.toLowerCase().includes(filter.search.toLowerCase())) {
        return false;
      }
      return true;
    });
  }

  async create(data: Omit<Tenant, "id" | "createdAt" | "updatedAt">): Promise<Tenant> {
    const now = new Date();
    const tenant = {
      ...data,
      id: createTenantId(data.slug),
      createdAt: now,
      updatedAt: now,
    };
    if (this.tenants.has(tenant.id)) {
      throw new TenantAlreadyExistsProblem(tenant.id);
    }

    this.tenants.set(tenant.id, tenant);
    return tenant;
  }

  async update(
    id: string,
    data: Partial<Omit<Tenant, "id" | "createdAt" | "updatedAt">>,
  ): Promise<Tenant> {
    const previous = await this.findById(id);
    if (!previous) throw new TenantNotFoundProblem(id);

    const tenant = {
      ...previous,
      ...data,
      updatedAt: new Date(),
    };

    this.tenants.set(id, tenant);
    return tenant;
  }

  async delete(id: string): Promise<boolean> {
    return this.tenants.delete(id);
  }

  async updateSettings(id: string, settings: Partial<TenantSettings>): Promise<Tenant> {
    const previous = await this.findById(id);
    if (!previous) throw new TenantNotFoundProblem(id);

    return this.update(id, {
      settings: {
        ...previous.settings,
        ...settings,
      },
    });
  }

  async exists(id: string): Promise<boolean> {
    return this.tenants.has(id);
  }
}

export class InMemoryAccessProvider implements AccessProvider {
  private readonly tuples = new Map<string, RelationTuple>();

  async check(request: CheckRequest): Promise<CheckResult> {
    const allowed = this.tuples.has(
      relationKey(request.tenantId, {
        object: request.object,
        relation: request.relation,
        subject: request.subject,
      }),
    );

    return allowed ? { decision: "allow", allowed: true } : { decision: "deny", allowed: false };
  }

  async grant(request: GrantRequest): Promise<void> {
    this.tuples.set(relationKey(request.tenantId, request.tuple), request.tuple);
  }

  async revoke(request: RevokeRequest): Promise<void> {
    this.tuples.delete(relationKey(request.tenantId, request.tuple));
  }

  async list(request: ListRequest): Promise<RelationTuple[]> {
    return [...this.tuples.entries()]
      .filter(([key, tuple]) => {
        if (!key.startsWith(`${request.tenantId}:`)) return false;
        if (request.object && tuple.object !== request.object) return false;
        if (request.relation && tuple.relation !== request.relation) return false;
        if (request.subject && tuple.subject !== request.subject) return false;
        return true;
      })
      .map(([, tuple]) => tuple);
  }
}

export class InMemoryMeterRepository extends MeterRepository {
  readonly replayContract = "idempotent" as const;

  private readonly meters = new Map<string, MeterDefinition>();
  private readonly usageRecords: UsageRecord[] = [];

  async findByMeterIdAndTenant(meterId: string, tenantId: string): Promise<MeterDefinition | null> {
    return this.meters.get(`${tenantId}:${meterId}`) ?? null;
  }

  async save(meter: MeterRegistrationOptions): Promise<MeterDefinition> {
    const now = new Date();
    const definition = {
      ...meter,
      id: `${meter.tenantId}:${meter.meterId}`,
      createdAt: now,
      updatedAt: now,
    };

    this.meters.set(`${meter.tenantId}:${meter.meterId}`, definition);
    return definition;
  }

  async findAll(): Promise<MeterDefinition[]> {
    return [...this.meters.values()];
  }

  async findByTenant(tenantId: string): Promise<MeterDefinition[]> {
    return [...this.meters.values()].filter((meter) => meter.tenantId === tenantId);
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

export class InMemoryUsageStorage implements UsageStorage {
  readonly replayContract = "idempotent" as const;

  private readonly records: UsageRecord[] = [];
  private readonly idempotencyKeys = new Set<string>();
  private readonly recordedKeys = new Set<string>();
  private readonly quotaResults = new Map<string, AtomicQuotaCheckResult>();

  async record(usage: UsageRecord): Promise<void> {
    const key = this.buildIdempotencyKey(usage.tenantId, usage.meterId, usage.idempotencyKey);
    if (this.recordedKeys.has(key)) {
      return;
    }
    this.recordedKeys.add(key);
    this.records.push(usage);
  }

  async getUsage(options: UsageQueryOptions): Promise<number> {
    return this.records
      .filter((record) => isWithinRange(record, options))
      .reduce((total, record) => total + record.value, 0);
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
    return this.records.filter((record) => isWithinRange(record, options));
  }

  async deleteUsageRecords(options: UsageQueryOptions, records: UsageRecord[]): Promise<void> {
    const deleteIds = new Set(records.map((record) => record.id));
    const keep = this.records.filter(
      (record) => !deleteIds.has(record.id) || !isWithinRange(record, options),
    );

    this.records.length = 0;
    this.records.push(...keep);
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

  async resetBillingCycle(tenantId: string, meterId?: string): Promise<void> {
    const keep = this.records.filter(
      (record) =>
        record.tenantId !== tenantId || (meterId !== undefined && record.meterId !== meterId),
    );

    this.records.length = 0;
    this.records.push(...keep);
  }

  private buildIdempotencyKey(tenantId: string, meterId: string, idempotencyKey: string): string {
    return `${tenantId}:${meterId}:${idempotencyKey}`;
  }
}

export class InMemoryRedisClient implements RedisClient {
  readonly scriptKeyAccess = "multi-key" as const;

  private readonly values = new Map<string, string>();
  private readonly sortedSets = new Map<string, Array<{ score: number; member: string }>>();

  async zadd(key: string, score: number, member: string): Promise<number> {
    const values = this.sortedSets.get(key) ?? [];
    values.push({ score, member });
    this.sortedSets.set(key, values);
    return 1;
  }

  async zrangebyscore(
    key: string,
    min: number,
    max: number,
    withScores?: "WITHSCORES",
  ): Promise<string[]> {
    const values = (this.sortedSets.get(key) ?? []).filter(
      (entry) => entry.score >= min && entry.score <= max,
    );

    if (withScores === "WITHSCORES") {
      return values.flatMap((entry) => [entry.member, String(entry.score)]);
    }

    return values.map((entry) => entry.member);
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

type InMemoryMeteringDeliveryState = {
  status: "PROCESSING" | "PUBLISHING" | "EVENTS_PENDING" | "COMPLETED";
  token?: string;
  leaseExpiresAt?: number;
  operationId?: string;
  delivery?: string;
};

export class InMemoryExecutionStore implements ExecutionStore, ExecutionLogStore {
  private readonly executions = new Map<string, Execution>();
  private idCounter = 0;

  async create(params: CreateExecutionParams): Promise<Execution> {
    if (params.idempotencyKey) {
      const existing = await this.findByIdempotencyKey(params.idempotencyKey);
      if (existing) {
        return existing;
      }
    }

    const execution: Execution = {
      id: `exec_${++this.idCounter}`,
      type: params.type,
      status: "pending",
      payload: params.payload,
      attempts: 0,
      maxAttempts: params.maxAttempts ?? 1,
      timeout: params.timeout,
      scheduledFor: params.scheduledFor,
      idempotencyKey: params.idempotencyKey,
      replayOf: params.replayOf,
      logs: params.logs,
      parentId: params.parentId,
      metadata: params.metadata,
      createdAt: new Date(),
    };

    this.executions.set(execution.id, execution);
    return execution;
  }

  async findById(id: string): Promise<Execution | null> {
    return this.executions.get(id) ?? null;
  }

  async findByIdempotencyKey(key: string): Promise<Execution | null> {
    return (
      [...this.executions.values()].find((execution) => execution.idempotencyKey === key) ?? null
    );
  }

  async update(id: string, data: Partial<Execution>): Promise<Execution> {
    const execution = await this.findById(id);
    if (!execution) {
      throw new Error(`Execution with id '${id}' not found`);
    }

    const updated = { ...execution, ...data };
    this.executions.set(id, updated);
    return updated;
  }

  async mergeCheckpoint(id: string, key: string, value: unknown): Promise<Execution> {
    const execution = this.executions.get(id);
    if (!execution) {
      throw ExecutionProblems.notFound(`Execution with id '${id}' not found`);
    }
    const checkpoint = prepareExecutionCheckpoint(key, value);
    const updated = {
      ...execution,
      checkpoints: { ...execution.checkpoints, [key]: checkpoint.value },
    };
    this.executions.set(id, updated);
    return updated;
  }

  async updateIfStatus(
    id: string,
    expectedStatus: Execution["status"],
    data: Partial<Execution>,
  ): Promise<Execution | null> {
    const execution = this.executions.get(id);
    return execution?.status === expectedStatus ? this.update(id, data) : null;
  }

  async listRunning(options: { afterId?: string; limit: number }): Promise<Execution[]> {
    return [...this.executions.values()]
      .filter(
        (execution) =>
          execution.status === "running" &&
          (options.afterId === undefined || execution.id > options.afterId),
      )
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, options.limit);
  }

  async list(options: ListExecutionsOptions = {}): Promise<Execution[]> {
    let executions = [...this.executions.values()];

    if (options.status) {
      executions = executions.filter((execution) => execution.status === options.status);
    }
    if (options.type) {
      executions = executions.filter((execution) => execution.type === options.type);
    }
    if (options.parentId !== undefined) {
      executions = executions.filter((execution) => execution.parentId === options.parentId);
    }
    if (options.replayOf !== undefined) {
      executions = executions.filter((execution) => execution.replayOf === options.replayOf);
    }

    const offset = options.offset ?? 0;
    return executions.slice(offset, options.limit ? offset + options.limit : undefined);
  }

  async appendLog(id: string, entry: ExecutionLogEntry): Promise<Execution> {
    const execution = await this.findById(id);
    if (!execution) {
      throw new Error(`Execution with id '${id}' not found`);
    }

    return this.update(id, {
      logs: [...(execution.logs ?? []), entry],
    });
  }

  async delete(id: string): Promise<void> {
    this.executions.delete(id);
  }
}

export class InMemoryEventBus implements EventBus {
  readonly published: DomainEvent[] = [];
  private readonly subscriptions = new Set<EventSubscription>();

  async publish(event: DomainEvent): Promise<void> {
    this.published.push(event);
  }

  subscribe(subscription: EventSubscription): void {
    this.subscriptions.add(subscription);
  }

  unsubscribe(subscription: EventSubscription): void {
    this.subscriptions.delete(subscription);
  }

  clear(): void {
    this.published.length = 0;
    this.subscriptions.clear();
  }
}

export class NoopTxAdapter implements TxAdapter<unknown> {
  async transaction<T>(fn: (client: unknown) => Promise<T>): Promise<T> {
    return fn({});
  }

  async savepoint<T>(_client: unknown, fn: (client: unknown) => Promise<T>): Promise<T> {
    return fn({});
  }

  supportsSavepoint(): boolean {
    return true;
  }
}
