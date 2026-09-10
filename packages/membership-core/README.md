# @croco/membership-core

테넌트 멤버십, 역할 계층, 소유권 보호, 좌석 제한을 다루는 멤버십 코어 패키지입니다.

## 설치

```bash
pnpm add @croco/membership-core
```

## 사용법

```ts
import { InMemoryMembershipStore, MembershipManager } from "@croco/membership-core";

const store = new InMemoryMembershipStore();
const manager = new MembershipManager({
  store,
  eventPublisher: idempotentEventPublisher,
  seatLimitChecker,
  eventDelivery: "development",
});

await manager.addMember("tenant-123", "user-1", "owner", "member:add:user-1");
await manager.addMember("tenant-123", "user-2", "member", "member:add:user-2");
await manager.updateRole("tenant-123", "user-2", "admin", "member:promote:user-2");
await manager.transferOwnership("tenant-123", "user-1", "user-2", "owner:transfer:user-2");
await manager.publishPendingEvents();
```

## API 레퍼런스

### 핵심 클래스

- `MembershipManager`, 멤버 추가, 제거, 역할 변경, 소유권 이전을 담당합니다.
- `MembershipService`, 동일한 도메인 기능을 서비스 형태로 제공합니다.
- `MembershipOwnerGuard`, 읽기 전용 사전 검증을 위한 deprecated 호환 API입니다. 동시 쓰기 보호에는 저장소의 원자적
  명령 API를 사용해야 합니다.
- `InMemoryMembershipStore`, 테스트용 저장소 구현체입니다.

### 저장소와 확장 포인트

- `MembershipStore`, 영속 저장소 계약입니다. 공개 쓰기는 idempotency key와 recoverable event intent를 함께
  커밋하는 `execute()`를 통해 수행합니다. 어댑터의 protected 원시 쓰기는 이 명령 경계 안에서만 호출해야 합니다.
  커스텀 어댑터도 이 원자적 경계에서 `update_role`의 비소유자 → 소유자 전이를 거부해야 합니다.
- `SeatLimitChecker`, entitlements 기반 좌석 제한 계약입니다.
- `AbstractMembershipManager`, invitation 같은 상위 패키지가 의존하는 추상 계약입니다.

### 주요 타입과 유틸리티

- `Membership`, `MembershipCreateInput`, `MembershipUpdateInput`, `MembershipRole`
- `MembershipOwnerMutationInput`, `MembershipOwnerMutationResult`
- `MembershipOwnershipTransferInput`, `MembershipOwnershipTransferResult`
- `ROLE_HIERARCHY`, `VALID_MEMBERSHIP_ROLES`
- `isMembershipRole`, `isHigherRole`, `isLowerRole`, `canPromote`, `canDemote`

### 이벤트와 문제 타입

- 이벤트: `MembershipCreatedEvent`, `MembershipUpdatedEvent`, `MembershipRemovedEvent`
- 문제 타입: `MembershipNotFoundProblem`, `AlreadyMemberProblem`, `InvalidRoleProblem`, `OwnershipTransferRequiredProblem`, `SeatLimitExceededProblem`, `LastOwnerCannotBeRemovedProblem`

## 구현 포인트

- 역할 계층은 `owner > admin > member > viewer` 순서입니다.
- `updateRole()`로 일반 멤버를 `owner`로 승격하면 `RoleHierarchyViolationProblem`이 발생합니다. 기존 멤버에게
  소유권을 넘길 때는 `transferOwnership()`을 사용합니다. 같은 역할 지정과 일반 역할 간 변경은 허용됩니다.
- 소유자 제거, 강등, 이전은 원자적으로 적용되며 마지막 소유자는 항상 유지됩니다.
- `SeatLimitChecker`를 주입하면 플랜별 좌석 수를 강제할 수 있습니다.
- 명령은 상태와 recoverable event intent만 원자적으로 커밋합니다. `publishPendingEvents()`는 요청 transaction 밖의
  relay 또는 worker에서 호출해야 하며, publisher는 `eventId` 기준 중복 제거를 보장해야 합니다.
- `MembershipManager`와 `MembershipService`는 options 객체로 직접 생성합니다. 프레임워크 DI를 사용할 때는
  애플리케이션 provider factory에서 이 객체를 구성해 등록합니다.
