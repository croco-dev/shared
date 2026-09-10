# @croco/invitation-drizzle

`@croco/invitation-core`용 Drizzle 저장소입니다.

## 설치

```bash
pnpm add @croco/invitation-drizzle @croco/invitation-core drizzle-orm
```

## 사용법

```typescript
import {
  AesGcmInvitationTokenCipher,
  DrizzleDomainPolicyStore,
  DrizzleInvitationStore,
} from "@croco/invitation-drizzle";
import { TxManager } from "@croco/tx-core";

const txManager = new TxManager(adapter, { defaultNesting: "join" });
const tokenCipher = new AesGcmInvitationTokenCipher({
  activeKeyId: "2026-07",
  keys: {
    "2026-07": Buffer.from(process.env.INVITATION_TOKEN_KEY_BASE64!, "base64"),
  },
});
const invitationStore = new DrizzleInvitationStore(db, txManager, tokenCipher);
const policyStore = new DrizzleDomainPolicyStore(db, txManager);

await invitationStore.save({
  id: "inv-1",
  tenantId: "tenant-1",
  inviterId: "user-1",
  email: "new@example.com",
  tokenHash: "hash-123",
  type: "email",
  role: "member",
  status: "pending",
  expiresAt: new Date("2026-12-31"),
  acceptedAt: null,
  revokedAt: null,
  createdAt: new Date(),
});

await policyStore.save({
  id: "policy-1",
  tenantId: "tenant-1",
  domain: "example.com",
  role: "member",
  enabled: true,
  createdAt: new Date(),
});

const invitation = await invitationStore.findByTokenHash("hash-123");
const policy = await policyStore.findByTenantAndDomain("tenant-1", "example.com");
```

## API 레퍼런스

### `DrizzleInvitationStore`

- `findById(id)`, ID로 초대를 조회합니다.
- `findByTokenHash(tokenHash)`, 토큰 해시로 초대를 조회합니다.
- `findByTenantAndEmail(tenantId, email)`, 테넌트와 이메일로 초대를 조회합니다.
- `findAllByTenant(tenantId)`, 테넌트의 모든 초대를 반환합니다.
- `save(invitation)`, 초대를 upsert로 저장합니다.
- `createEmailInvitation(input)`, 이메일 및 링크 초대와 재생 가능한 알림/이벤트 의도를 하나의 트랜잭션으로 저장합니다.
- 단계별 claim/complete/release 메서드는 동시에 하나의 전달 작업만 수행하도록 fencing합니다.
- `activateEmailInvitation(tenantId, idempotencyKey)`, 이벤트와 알림 완료 뒤 초대를 `pending`으로 활성화합니다.
- `updateStatus(id, status)`, 초대 상태를 갱신합니다.
- `countIssuedByTenant(tenantId, since)`, `createdAt >= since`인 테넌트의 모든 초대를 상태와 무관하게 집계합니다. 상태가 바뀌어도 이 초대는 발급 할당량에 계속 포함됩니다.
- `countPendingByTenant(tenantId, since)`, 기간 내 대기 초대 수를 반환합니다.

### `DrizzleDomainPolicyStore`

- `findByTenantAndDomain(tenantId, domain)`, 도메인 정책을 조회합니다.
- `findAllByTenant(tenantId)`, 테넌트의 모든 정책을 조회합니다.
- `save(policy)`, 도메인 정책을 upsert로 저장합니다.
- `delete(tenantId, domain)`, 도메인 정책을 삭제합니다.
- 자동 가입 intent 메서드는 멤버십 결과를 저장하고 이벤트 전달을 lease/claim으로 fencing합니다.

### 스키마와 토큰

- `invitations`, 초대 엔터티 스키마입니다.
- `invitationEmailCreationIntents`, tenant-scoped 생성 멱등성과 전달 단계 스키마입니다.
- `domainPolicies`, 도메인 정책 스키마입니다.
- `domainAutoJoinIntents`, 자동 가입 멤버십 결과와 이벤트 전달 의도 스키마입니다.
- `DRIZZLE_INVITATION_TOKEN`, 초대 저장소용 DB 토큰입니다.
- `DRIZZLE_DOMAIN_POLICY_TOKEN`, 도메인 정책 저장소용 DB 토큰입니다.

`invitation_email_creation_intents`는 기존 테이블 이름을 유지하면서 이메일 및 링크 초대의 응답 유실과
모호한 provider ACK 뒤에도 동일 토큰을 재생하되,
AES-256-GCM ciphertext만 저장합니다. 새 런타임을 배포하기 전에
export된 `addEmailCreationIntents(db)` migration을 적용하고, 키 관리 시스템에서 32-byte 키를
주입하세요. 키 교체 시 기존 intent의 보존 기간이 끝날 때까지 이전 key ID도 유지해야 합니다.

도메인 자동 가입을 사용하기 전에 export된 `addDomainAutoJoinIntents(db)` migration도 적용하세요.
`DrizzleDomainPolicyStore`와 멤버십 저장소는 같은 `TxManager`를 사용해야 멤버십과 intent가 하나의
트랜잭션에 참여합니다.
