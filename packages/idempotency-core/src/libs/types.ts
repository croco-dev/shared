export type IdempotencyKeySourceKind =
  | "explicit"
  | "request-fingerprint"
  | "provider-event"
  | "tenant-scoped";

export type ExplicitIdempotencyKeySource = {
  readonly kind: "explicit";
  readonly key: string;
  readonly fingerprint?: string;
};

export type RequestFingerprintIdempotencyKeySource = {
  readonly kind: "request-fingerprint";
  readonly method: string;
  readonly path: string;
  readonly bodyFingerprint: string;
  readonly key?: string;
  readonly queryFingerprint?: string;
  readonly headerFingerprint?: string;
  readonly fingerprint?: string;
};

export type ProviderEventIdempotencyKeySource = {
  readonly kind: "provider-event";
  readonly provider: string;
  readonly eventId: string;
  readonly fingerprint?: string;
};

export type TenantScopedIdempotencyKeySource = {
  readonly kind: "tenant-scoped";
  readonly tenantId: string;
  readonly key: string;
  readonly fingerprint?: string;
};

export type IdempotencyKeySource =
  | ExplicitIdempotencyKeySource
  | RequestFingerprintIdempotencyKeySource
  | ProviderEventIdempotencyKeySource
  | TenantScopedIdempotencyKeySource;

export type IdempotencyScope = {
  readonly namespace?: string;
  readonly tenantId?: string | null;
};

export type DeriveIdempotencyKeyOptions = IdempotencyScope & {
  readonly source: IdempotencyKeySource;
};

export type IdempotencyTelemetryAttributes = {
  readonly "croco.idempotency.key": string;
  readonly "croco.idempotency.namespace": string;
  readonly "croco.idempotency.scope": "global" | "tenant";
  readonly "croco.idempotency.tenant_id"?: string;
  readonly "croco.idempotency.source": IdempotencyKeySourceKind;
  readonly "croco.idempotency.fingerprint": string;
};

export type DerivedIdempotencyKey = {
  readonly key: string;
  readonly fingerprint: string;
  readonly namespace: string;
  readonly tenantId: string | null;
  readonly scope: "global" | "tenant";
  readonly source: IdempotencyKeySourceKind;
  readonly storageKey: string;
  readonly telemetryAttributes: IdempotencyTelemetryAttributes;
};

export type IdempotencyRecordStatus = "in-flight" | "completed" | "failed";

export type IdempotencyRecordBase = DerivedIdempotencyKey & {
  readonly status: IdempotencyRecordStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly expiresAt: Date | null;
  readonly metadata: Record<string, unknown>;
};

export type IdempotencyInFlightRecord = IdempotencyRecordBase & {
  readonly status: "in-flight";
  readonly reservationId: string;
  readonly reservedAt: Date;
};

export type IdempotencyCompletedRecord<TResult = unknown> = IdempotencyRecordBase & {
  readonly status: "completed";
  readonly completedAt: Date;
  readonly response: TResult;
};

export type IdempotencyFailedRecord = IdempotencyRecordBase & {
  readonly status: "failed";
  readonly failedAt: Date;
  readonly problem?: {
    readonly code: string;
    readonly status?: number;
    readonly detail?: string;
  };
  readonly retryable: boolean;
};

export type IdempotencyRecord<TResult = unknown> =
  | IdempotencyInFlightRecord
  | IdempotencyCompletedRecord<TResult>
  | IdempotencyFailedRecord;

export type IdempotencyReservation = {
  readonly storageKey: string;
  readonly reservationId: string;
  readonly key: DerivedIdempotencyKey;
};

export type IdempotencyReserveOptions = {
  readonly ttlMs?: number;
  readonly metadata?: Record<string, unknown>;
};

export type IdempotencyCommitOptions<TResult> = {
  readonly key: DerivedIdempotencyKey;
  readonly reservationId: string;
  readonly response: TResult;
  readonly ttlMs?: number;
  readonly metadata?: Record<string, unknown>;
};

export type IdempotencyFailOptions = {
  readonly key: DerivedIdempotencyKey;
  readonly reservationId: string;
  readonly retryable?: boolean;
  readonly ttlMs?: number;
  readonly metadata?: Record<string, unknown>;
  readonly problem?: {
    readonly code: string;
    readonly status?: number;
    readonly detail?: string;
  };
};

export type IdempotencyExpireOptions = {
  readonly key: DerivedIdempotencyKey;
};

export type IdempotencyReserveResult<TResult = unknown> =
  | {
      readonly outcome: "reserved";
      readonly reservation: IdempotencyReservation;
      readonly record: IdempotencyInFlightRecord;
    }
  | {
      readonly outcome: "replay";
      readonly record: IdempotencyCompletedRecord<TResult>;
      readonly response: TResult;
    }
  | {
      readonly outcome: "in-flight";
      readonly record: IdempotencyInFlightRecord;
    }
  | {
      readonly outcome: "failed";
      readonly record: IdempotencyFailedRecord;
    };

export type IdempotencyExecutionRequest = {
  /** Overrides handler failure retryability; audit and commit recovery are unchanged. */
  readonly isRetryable?: (error: unknown) => boolean;
  readonly key: DerivedIdempotencyKey;
  readonly ttlMs?: number;
  readonly metadata?: Record<string, unknown>;
};

export type IdempotencyExecutionResult<TResult> =
  | {
      readonly outcome: "executed";
      readonly response: TResult;
      readonly record: IdempotencyCompletedRecord<TResult>;
    }
  | {
      readonly outcome: "replayed";
      readonly response: TResult;
      readonly record: IdempotencyCompletedRecord<TResult>;
    }
  | {
      readonly outcome: "in-flight";
      readonly record: IdempotencyInFlightRecord;
    }
  | {
      readonly outcome: "failed";
      readonly record: IdempotencyFailedRecord;
    };

export type IdempotencyStore<TResult = unknown> = {
  reserve(
    key: DerivedIdempotencyKey,
    options?: IdempotencyReserveOptions,
  ): Promise<IdempotencyReserveResult<TResult>>;
  commit(options: IdempotencyCommitOptions<TResult>): Promise<IdempotencyCompletedRecord<TResult>>;
  replay(key: DerivedIdempotencyKey): Promise<IdempotencyCompletedRecord<TResult> | null>;
  fail(options: IdempotencyFailOptions): Promise<IdempotencyFailedRecord>;
  expire(options: IdempotencyExpireOptions): Promise<boolean>;
};

export type IdempotencyAuditEvent = {
  readonly type:
    | "idempotency.reserved"
    | "idempotency.replayed"
    | "idempotency.in_flight"
    | "idempotency.failed"
    | "idempotency.conflict";
  readonly key: string;
  readonly storageKey: string;
  readonly namespace: string;
  readonly tenantId: string | null;
  readonly source: IdempotencyKeySourceKind;
  readonly fingerprint: string;
  readonly metadata?: Record<string, unknown>;
};

export type IdempotencyAuditSink = {
  recordIdempotency(event: IdempotencyAuditEvent): void | Promise<void>;
};

export type IdempotencyHandler<TResult> = () => Promise<TResult> | TResult;
