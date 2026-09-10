# @croco/invitation-core

이메일 초대, 링크 초대, 도메인 자동 가입, 스팸 방지를 제공하는 초대 코어 패키지입니다.

## 설치

```bash
pnpm add @croco/invitation-core
```

## 사용법

```ts
import { InMemoryInvitationStore, InvitationManager } from "@croco/invitation-core";

const store = new InMemoryInvitationStore();
const manager = new InvitationManager(
  store,
  membershipManager,
  notificationService,
  eventPublisher,
  txManager,
);

const token = await manager.createEmailInvitation({
  // Reuse this key when retrying the same semantic invitation request.
  idempotencyKey: "invite:new-user@example.com:member",
  tenantId: "tenant-123",
  inviterId: "user-1",
  email: "new-user@example.com",
  role: "member",
});

const linkToken = await manager.createLinkInvitation({
  // A retry of this command returns the same token and resumes event delivery.
  idempotencyKey: "invite-link:tenant-123:member",
  tenantId: "tenant-123",
  inviterId: "user-1",
  role: "member",
});

await manager.acceptInvitation({ token, userId: "user-2", email: "new-user@example.com" });
```

```ts
import { DomainPolicyManager, InMemoryDomainPolicyStore } from "@croco/invitation-core";

const domainPolicyManager = new DomainPolicyManager(
  domainStore,
  membershipManager,
  eventPublisher,
  txManager,
);

await domainPolicyManager.addDomainPolicy("tenant-123", "acme.com", "member");
await domainPolicyManager.tryAutoJoin("tenant-123", "user-3", "user@acme.com");
```

## API 레퍼런스

### 핵심 클래스

- `InvitationManager`, 초대 생성, 수락, 거절, 취소, 재전송을 담당합니다.
- `RateLimitedInvitationService`, 초대 rate limit과 batch invite를 제공합니다. 시간당·일간 한도는 현재 상태와 무관한 발급 건수를 기준으로 하므로 수락·취소·거절·만료로 복구되지 않습니다.
- `DomainPolicyManager`, 이메일 도메인 기반 자동 가입 정책을 관리합니다.
- `InMemoryInvitationStore`, `InMemoryDomainPolicyStore`, 테스트용 저장소 구현체입니다.

### 저장소와 유틸리티

- `InvitationStore`, `DomainPolicyStore`, 영속 저장소 계약입니다. 사용자 정의 `InvitationStore`는 `countIssuedByTenant(tenantId, since)`에서 해당 테넌트의 `createdAt >= since`인 모든 상태의 초대를 집계해야 합니다. 기존 `countPendingByTenant`는 대기 초대만 집계합니다.
- `generateToken`, `hashToken`, 안전한 초대 토큰 유틸리티입니다.
- `PUBLIC_EMAIL_DOMAINS`, 자동 가입에서 제외할 공개 이메일 도메인 목록입니다.

### 주요 타입

- `CreateEmailInvitationInput`, `CreateLinkInvitationInput`, `AcceptInvitationInput`
- `Invitation`, `InvitationCreateInput`, `InvitationStatus`, `InvitationType`
- `BatchInviteOptions`, `BatchInviteResult`, `RateLimitConfig`, `DomainPolicy`

### 이벤트와 문제 타입

- 이벤트: `InvitationCreatedEvent`, `InvitationAcceptedEvent`, `InvitationDeclinedEvent`, `InvitationRevokedEvent`, `DomainPolicyAddedEvent`, `DomainAutoJoinedEvent`
- 문제 타입: `InvitationNotFoundProblem`, `InvitationExpiredProblem`, `InvitationEmailMismatchProblem`, `InvitationRateLimitExceededProblem`, `DuplicateInvitationProblem`, `PublicEmailDomainNotAllowedProblem`

## 구현 포인트

- 이메일과 링크 초대는 필요한 전달이 완료되기 전까지 `creating` 상태이며, 성공한 뒤에만 수락 가능한
  `pending` 상태가 됩니다.
- 같은 초대 생성 재시도는 같은 `idempotencyKey`를 사용해야 동일 토큰과 전달 의도를 재생합니다.
- 초대 재전송도 `resendInvitation(invitationId, idempotencyKey)`에 같은 명령 키를 다시 전달해야 실패한
  링크 생성 단계를 이어갑니다.
- 이메일 초대는 토큰을 해시해 저장하고, 링크 초대는 이메일 없이 공유할 수 있습니다.
- `expiresInDays`는 0보다 큰 정수 일수만 허용합니다. 0, 음수, 소수, `NaN`, 무한대 및 유효한 날짜를
  만들 수 없는 큰 값은 토큰 생성이나 저장 전에 거부됩니다.
- 도메인 정책은 회사 이메일 사용자를 자동으로 멤버십에 연결할 때 유용합니다.
- 도메인 자동 가입은 테넌트, 사용자, 정규화된 이메일에서 만든 멱등성 키로 멤버십 결과와 이벤트 의도를
  함께 저장합니다. `DomainPolicyStore`, `MembershipManager`가 같은 `TxManager`에 참여해야 합니다.
- 이벤트 발행이 실패하면 같은 `tryAutoJoin` 입력으로 재시도해 저장된 멤버십을 반환하고 미전달 이벤트를
  재생합니다.
- 도메인 자동 가입은 정확히 하나의 `@`와 공백 없는 로컬·도메인 구간을 요구합니다. 국제화 도메인은
  punycode로 자동 변환하지 않으므로 정책과 이메일에 같은 유니코드 또는 ASCII 표기를 사용해야 합니다.
- batch invite는 성공과 실패를 분리해 반환합니다.
