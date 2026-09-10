/**
 * @packageDocumentation
 *
 * @croco/membership-core
 *
 * 테넌트-사용자 멤버십 관리를 위한 핵심 도메인 로직입니다.
 *
 * @feature 멤버십 라이프사이클 관리 - 사용자 추가, 제거, 역할 변경
 * @feature 역할 기반 접근 제어 - owner, admin, member, viewer 계층 구조
 * @feature 소유권 보호 - 마지막 소유자 제거/강등 방지
 * @feature 소유권 이전 - 안전한 소유권 이전 인터페이스
 * @feature 좌석 제한 통합 - entitlements-core 연동
 * @feature 도메인 이벤트 - 멤버십 변경 이벤트 발행
 * @feature 저장소 추상화 - MembershipStore 인터페이스로 다양한 저장소 지원
 *
 * @example 기본 사용법
 * ```typescript
 * import { MembershipManager, InMemoryMembershipStore } from '@croco/membership-core';
 *
 * const store = new InMemoryMembershipStore();
 * const manager = new MembershipManager({ store, eventPublisher, eventDelivery: 'development' });
 *
 * // 멤버 추가
 * const membership = await manager.addMember('tenant-123', 'user-456', 'member', 'member:add:user-456');
 *
 * // 역할 변경
 * await manager.updateRole('tenant-123', 'user-456', 'admin', 'member:promote:user-456');
 *
 * // 소유권 이전
 * await manager.transferOwnership('tenant-123', 'current-owner', 'new-owner', 'owner:transfer:new-owner');
 *
 * // 멤버 제거
 * await manager.removeMember('tenant-123', 'user-456', 'member:remove:user-456');
 * ```
 *
 * @description 이 패키지는 다음을 제공합니다:
 * - {@link MembershipManager}: 멤버십 관리 매니저
 * - {@link MembershipService}: 멤버십 관리 서비스
 * - {@link MembershipStore}: 저장소 인터페이스
 * - {@link InMemoryMembershipStore}: 인메모리 저장소 구현체
 * - {@link SeatLimitChecker}: 좌석 제한 체커 인터페이스
 * - 도메인 이벤트: {@link MembershipCreatedEvent}, {@link MembershipRemovedEvent}, {@link MembershipUpdatedEvent}
 * - 문제 타입: {@link MembershipNotFoundProblem}, {@link AlreadyMemberProblem}, {@link LastOwnerCannotBeRemovedProblem}
 */

/**
 * 멤버십 생성 도메인 이벤트
 *
 * @description 사용자가 테넌트에 멤버로 추가될 때 발행하는 이벤트입니다.
 *
 * @example 이벤트 핸들러 등록
 * ```typescript
 * @RegisterEventHandler(MembershipCreatedEvent)
 * class Handler implements EventHandler<MembershipCreatedEvent> {
 *   async handle(event: MembershipCreatedEvent) {
 *   }
 * }
 * ```
 */
export { MembershipCreatedEvent } from "./libs/events/MembershipCreatedEvent";

/**
 * 멤버십 제거 도메인 이벤트
 *
 * @description 사용자가 테넌트에서 제거될 때 발행하는 이벤트입니다.
 *
 * @example 이벤트 핸들러 등록
 * ```typescript
 * @RegisterEventHandler(MembershipRemovedEvent)
 * class Handler implements EventHandler<MembershipRemovedEvent> {
 *   async handle(event: MembershipRemovedEvent) {
 *   }
 * }
 * ```
 */
export { MembershipRemovedEvent } from "./libs/events/MembershipRemovedEvent";

/**
 * 멤버십 역할 업데이트 도메인 이벤트
 *
 * @description 멤버의 역할이 변경될 때 발행하는 이벤트입니다.
 *
 * @example 이벤트 핸들러 등록
 * ```typescript
 * @RegisterEventHandler(MembershipUpdatedEvent)
 * class Handler implements EventHandler<MembershipUpdatedEvent> {
 *   async handle(event: MembershipUpdatedEvent) {
 *   }
 * }
 * ```
 */
export { MembershipUpdatedEvent } from "./libs/events/MembershipUpdatedEvent";
export {
  createMembershipStoreConformanceSuite,
  type MembershipStoreConformanceCase,
} from "./libs/conformance";
export type { MembershipEventIntent, MembershipEventIntentEvent } from "./libs/eventIntent";
export { createMembershipEventIntent } from "./libs/eventIntent";

/**
 * 인메모리 멤버십 저장소 구현체
 *
 * @description {@link MembershipStore} 인터페이스의 인메모리 구현체입니다. 테스트 및 프로토타이핑에 적합합니다.
 * 멤버십 쓰기는 {@link MembershipManager} 또는 {@link MembershipService}의 명령 API를 통해 수행합니다.
 *
 * @example 저장소 생성 및 사용
 * ```typescript
 * import { InMemoryMembershipStore, MembershipManager } from '@croco/membership-core';
 *
 * const store = new InMemoryMembershipStore();
 * const manager = new MembershipManager({ store, eventDelivery: 'development' });
 * const membership = await manager.addMember(
 *   'tenant-1',
 *   'user-1',
 *   'admin',
 *   'member:add:user-1',
 * );
 * ```
 */
export { InMemoryMembershipStore } from "./libs/InMemoryMembershipStore";

/**
 * 멤버십 매니저 추상 인터페이스
 *
 * @description 멤버십 관리 기능의 추상 인터페이스입니다.
 */
export { MembershipManager as AbstractMembershipManager } from "./libs/interfaces/AbstractMembershipManager";
export type { AddMembershipCommandResult } from "./libs/interfaces/AbstractMembershipManager";

/**
 * 멤버십 관리자
 *
 * @description 멤버십 라이프사이클을 관리하는 매니저입니다.
 * - 역할 계층 검증 (owner > admin > member > viewer)
 * - 소유권 보호 (마지막 소유자 제거/강등 방지)
 * - 소유권 이전 지원
 * - 좌석 제한 통합
 *
 * @example 매니저 사용
 * ```typescript
 * const manager = new MembershipManager({
 *   store,
 *   eventPublisher: idempotentEventPublisher,
 *   seatLimitChecker,
 *   eventDelivery: 'development',
 * });
 *
 * // 멤버 추가
 * await manager.addMember('tenant-123', 'user-456', 'member', 'member:add:user-456');
 *
 * // 역할 변경
 * await manager.updateRole('tenant-123', 'user-456', 'admin', 'member:promote:user-456');
 *
 * // 소유권 이전
 * await manager.transferOwnership('tenant-123', 'current-owner', 'new-owner', 'owner:transfer:new-owner');
 *
 * // 멤버 제거
 * await manager.removeMember('tenant-123', 'user-456', 'member:remove:user-456');
 *
 * // 커밋된 intent를 별도 relay 경계에서 발행
 * await manager.publishPendingEvents();
 * ```
 */
export { MembershipManager } from "./libs/MembershipManager";
/**
 * 멤버십 소유자 변경 가드
 *
 * @deprecated 검증과 저장 사이의 동시성 경쟁을 막을 수 없습니다. 소유자 변경에는
 * {@link MembershipManager} 또는 {@link MembershipService}의 명령 API를 사용하세요.
 *
 * @example 가드 사용
 * ```typescript
 * const guard = new MembershipOwnerGuard(store);
 *
 * await guard.validateOwnerMutation({
 *   tenantId: 'tenant-1',
 *   userId: 'user-1',
 *   currentRole: 'owner',
 *   operation: 'remove'
 * });
 * ```
 */
export { MembershipOwnerGuard } from "./libs/MembershipOwnerGuard";
/**
 * 멤버십 서비스
 *
 * @description 멤버십 라이프사이클을 관리하는 서비스입니다. 저장소의 원자적 소유자 변경 계약으로 소유자 제약 조건을 보호합니다.
 * - 역할 계층 검증
 * - 소유권 보호
 * - 소유권 이전 지원
 * - 좌석 제한 통합
 *
 * @example 서비스 사용
 * ```typescript
 * const service = new MembershipService({
 *   store,
 *   eventPublisher: idempotentEventPublisher,
 *   seatLimitChecker,
 * });
 *
 * // 멤버 추가
 * await service.addMember('tenant-123', 'user-456', 'member', 'member:add:user-456');
 *
 * // 역할 변경
 * await service.updateRole('tenant-123', 'user-456', 'admin', 'member:promote:user-456');
 *
 * // 소유권 이전
 * await service.transferOwnership('tenant-123', 'current-owner', 'new-owner', 'owner:transfer:new-owner');
 *
 * // 멤버 제거
 * await service.removeMember('tenant-123', 'user-456', 'member:remove:user-456');
 * ```
 */
export { MembershipService } from "./libs/MembershipService";
export type { MembershipEventPublisher, MembershipServiceOptions } from "./libs/MembershipService";

/**
 * 멤버십 저장소 인터페이스
 *
 * @description 멤버십 데이터 영속성을 위한 추상 인터페이스입니다. 데이터베이스, 인메모리 저장소 등 다양한 구현체가 가능합니다.
 * 지원되는 공개 쓰기 경계는 idempotency key와 recoverable event intent를 함께 처리하는 `execute()`입니다.
 *
 * @example 커스텀 저장소 구현
 * ```typescript
 * class PostgresMembershipStore extends MembershipStore {
 *   async findByTenantAndUser(tenantId: string, userId: string) {
 *     // DB 조회 로직
 *   }
 *   // 다른 메서드 구현...
 * }
 * ```
 */
export { MembershipStore } from "./libs/MembershipStore";
/**
 * 마지막 소유자 제거 불가 문제
 *
 * @description 테넌트의 마지막 소유자를 제거하려 할 때 발생하는 문제입니다.
 *
 * @example 에러 처리
 * ```typescript
 * try {
 *   await service.removeMember('tenant-1', 'last-owner');
 * } catch (err) {
 *   if (err instanceof LastOwnerCannotBeRemovedProblem) {
 *   }
 * }
 * ```
 */
export { LastOwnerCannotBeRemovedProblem } from "./libs/problems/LastOwnerCannotBeRemovedProblem";
/**
 * 멤버십 제약 조건 문제
 *
 * @description 멤버십 제약 조건 위반 시 발생하는 기본 문제 클래스입니다.
 *
 * @example 에러 처리
 * ```typescript
 * try {
 *   await service.removeMember('tenant-1', 'last-owner');
 * } catch (err) {
 *   if (err instanceof MembershipConstraintProblem) {
 *   }
 * }
 * ```
 */
export { MembershipConstraintProblem } from "./libs/problems/MembershipConstraintProblem";
/**
 * 이미 멤버임 문제
 *
 * @description 사용자가 이미 테넌트의 멤버일 때 발생하는 문제입니다.
 */
/**
 * 유효하지 않은 역할 문제
 *
 * @description 유효하지 않은 멤버십 역할을 사용하려 할 때 발생하는 문제입니다. 유효한 역할: owner, admin, member, viewer
 */
/**
 * 마지막 소유자 문제
 *
 * @description 테넌트의 마지막 소유자를 제거하거나 강등하려 할 때 발생하는 문제입니다.
 */
/**
 * 멤버십을 찾을 수 없음 문제
 *
 * @description 지정된 테넌트-사용자 조합에 대한 멤버십을 찾을 수 없을 때 발생하는 문제입니다.
 */
/**
 * 소유권 이전 필요 문제
 *
 * @description 소유자의 역할을 변경하려 할 때 소유권 이전이 필요한 경우 발생하는 문제입니다.
 */
/**
 * 역할 계층 위반 문제
 *
 * @description 역할 계층을 위반하는 권한 변경을 시도할 때 발생하는 문제입니다.
 */
/**
 * 좌석 제한 초과 문제
 *
 * @description 테넌트의 좌석 제한을 초과하여 멤버를 추가하려 할 때 발생하는 문제입니다.
 */
export {
  AlreadyMemberProblem,
  InvalidRoleProblem,
  LastOwnerProblem,
  MembershipNotFoundProblem,
  OwnershipTransferRequiredProblem,
  RoleHierarchyViolationProblem,
  SeatLimitExceededProblem,
} from "./libs/problems/MembershipProblems";
/**
 * 잘못된 멤버십 명령 문제
 *
 * @description 필수 입력 누락이나 허용되지 않은 연산 등 멤버십 명령 계약을 위반했을 때 발생하는 문제입니다.
 */
export { InvalidMembershipCommandProblem } from "./libs/problems/MembershipProblems";
/**
 * 멤버십 이벤트 발행 문제
 *
 * @description 멤버십 명령은 커밋되었지만 해당 이벤트 intent가 아직 발행되지 못했을 때 발생하는 문제입니다.
 */
export { MembershipEventPublicationProblem } from "./libs/problems/MembershipProblems";
/**
 * 멤버십 멱등성 충돌 문제
 *
 * @description 같은 idempotency key를 다른 명령 fingerprint로 재사용했을 때 발생하는 문제입니다.
 */
export { MembershipIdempotencyConflictProblem } from "./libs/problems/MembershipProblems";
/**
 * 좌석 제한 체커 인터페이스
 *
 * @description entitlements-core와 연동하여 테넌트의 좌석 제한을 체크하는 인터페이스입니다.
 *
 * @example 구현
 * ```typescript
 * class EntitlementSeatLimitChecker extends SeatLimitChecker {
 *   async checkSeatAvailability(tenantId: string): Promise<EntitlementQuotaStatus> {
 *     return this.entitlementManager.check(tenantId, 'seats');
 *   }
 *   // 다른 메서드 구현...
 * }
 * ```
 */
export { SeatLimitChecker } from "./libs/SeatLimitChecker";

/**
 * 멤버십 타입
 *
 * @description 멤버십 관련 타입들을 내보니다.
 *
 * @see {@link MembershipRole} - 멤버십 역할 타입 (owner | admin | member | viewer)
 * @see {@link Membership} - 멤버십 엔티티 타입
 * @see {@link MembershipCreateInput} - 멤버십 생성 입력 타입
 * @see {@link MembershipUpdateInput} - 멤버십 업데이트 입력 타입
 * @see {@link ROLE_HIERARCHY} - 역할 계층 상수
 * @see {@link isHigherRole} - 더 높은 역할 체크 함수
 * @see {@link isLowerRole} - 더 낮은 역할 체크 함수
 * @see {@link canPromote} - 승격 가능 여부 체크 함수
 * @see {@link canDemote} - 강등 가능 여부 체크 함수
 */
export * from "./libs/types";
