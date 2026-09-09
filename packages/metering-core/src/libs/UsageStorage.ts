import type { UsageQueryOptions, UsageRecord } from "./types";

export type AtomicQuotaCheckOptions = {
  tenantId: string;
  meterId: string;
  value: number;
  quota: number;
  allowOverQuota: boolean;
  usageRecord: UsageRecord;
};

export type AtomicQuotaCheckResult = {
  exceeded: boolean;
  newUsage: number;
};

/**
 * Redis 기반 실시간 Usage 저장소 인터페이스
 *
 * @description
 * 구현체: RedisUsageStorage (이 패키지 내) 또는 사용자 커스텀
 * 모든 메서드는 tenant 격리를 보장해야 함
 */
export interface UsageStorage {
  /**
   * MeteringService가 lease 만료 후 persistence를 안전하게 재개할 수 있음을 선언합니다.
   */
  readonly replayContract: "idempotent";

  /**
   * Usage 기록 (즉시 flush)
   * Redis Sorted Set에 저장
   *
   * 동일한 tenantId, meterId, idempotencyKey 조합의 재시도는 사용량을 중복 기록하지 않아야 합니다.
   */
  record(usage: UsageRecord): Promise<void>;

  /**
   * Usage 조회 (특정 기간 합산)
   */
  getUsage(options: UsageQueryOptions): Promise<number>;

  /**
   * Idempotency 체크 (SET NX 기반)
   * @returns true: 새 키 (기록 가능), false: 중복 (기록 불가)
   */
  isIdempotent(
    tenantId: string,
    meterId: string,
    idempotencyKey: string,
    ttlSeconds: number,
  ): Promise<boolean>;

  /**
   * Usage 데이터 조회 (배치 저장용)
   * Redis에서 특정 기간의 usage records 조회
   */
  fetchUsageRecords(options: UsageQueryOptions): Promise<UsageRecord[]>;

  /**
   * Usage 데이터 삭제 (배치 저장 후)
   * UsageAggregator requires this method and rejects unsupported storage at construction.
   * Delete only the supplied records; repeated deletion must be safe.
   * 저장이 성공한 경우에만 호출되어야 함
   */
  deleteUsageRecords?(options: UsageQueryOptions, records: UsageRecord[]): Promise<void>;

  /**
   * 동일한 tenantId, meterId, usageRecord.idempotencyKey 조합의 재시도는 사용량을 중복 기록하지 않고
   * 최초 호출과 동일한 quota 결과를 반환해야 합니다.
   */
  checkAndRecordWithinQuota(options: AtomicQuotaCheckOptions): Promise<AtomicQuotaCheckResult>;

  /**
   * 빌링 주기 리셋
   * 현재 빌링 주기의 모든 usage 데이터를 삭제합니다.
   * @param tenantId - 테넌트 ID
   * @param meterId - Meter ID (optional, 없으면 해당 테넌트의 모든 meter 리셋)
   */
  resetBillingCycle?(tenantId: string, meterId?: string): Promise<void>;
}
