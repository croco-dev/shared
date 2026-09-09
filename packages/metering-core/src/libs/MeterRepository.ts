import type { MeterDefinition, MeterRegistrationOptions, UsageRecord } from "./types";

/**
 * Meter 정의 및 Usage 데이터를 DB에 저장하는 추상 클래스
 *
 * @description
 * 구현체는 사용자가 제공 (예: Drizzle, Prisma 등)
 * metering-core는 이 추상 클래스만 의존
 */
export abstract class MeterRepository {
  /**
   * saveUsageRecords must persist each (tenantId, meterId, idempotencyKey) at most once,
   * including concurrent calls, overlapping batches, partial failures and process restarts.
   * Enforce uniqueness in persistent storage; an in-process cache is insufficient.
   */
  abstract readonly replayContract: "idempotent";

  /**
   * Meter 정의 조회 (tenantId + meterId로 검색)
   */
  abstract findByMeterIdAndTenant(
    meterId: string,
    tenantId: string,
  ): Promise<MeterDefinition | null>;

  /**
   * Meter 정의 등록 (정적 + 동적 모두 사용)
   */
  abstract save(meter: MeterRegistrationOptions): Promise<MeterDefinition>;

  /**
   * 앱 시작 시 모든 meter 로딩
   */
  abstract findAll(): Promise<MeterDefinition[]>;

  /**
   * 테넌트별 meter 조회
   */
  abstract findByTenant(tenantId: string): Promise<MeterDefinition[]>;

  /**
   * 배치 저장용 - Usage 레코드들을 DB에 영구 저장
   */
  abstract saveUsageRecords(records: UsageRecord[]): Promise<void>;
}
