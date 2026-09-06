# @croco/idempotency-core

HTTP 요청, webhook, task, event consumer가 같은 방식으로 idempotency key를 만들고 저장소 어댑터를 검증할 수 있는 코어 패키지입니다.

## 설치

```bash
pnpm add @croco/idempotency-core
```

## 사용법

```ts
import {
  IdempotencyCoordinator,
  InMemoryIdempotencyStore,
  deriveHttpIdempotencyKey,
} from "@croco/idempotency-core";

const store = new InMemoryIdempotencyStore<{ orderId: string }>();
const coordinator = new IdempotencyCoordinator({ store });

const key = deriveHttpIdempotencyKey({
  tenantId: "tenant-a",
  idempotencyKey: "checkout-123",
  method: "POST",
  path: "/orders",
  bodyFingerprint: "sha256:request-body",
});

const result = await coordinator.execute({ key, ttlMs: 86_400_000 }, async () => {
  return { orderId: "order-1" };
});
```

동일 key와 동일 fingerprint는 완료된 응답을 replay합니다. 동일 key에 다른 fingerprint가 들어오면 `IdempotencyConflictProblem`으로 실패합니다.
`InMemoryIdempotencyStore`는 응답과 metadata를 structured clone snapshot으로 저장하고 각 조회에서도 새 snapshot을 반환하므로
호출자 mutation이 이후 replay를 변경하지 않습니다. stable structured clone으로 타입과 값을 보존할 수 없는 값은
상태 변경 전에 `InvalidIdempotencySnapshotProblem`으로 실패합니다.
안정적인 snapshot을 위해 plain object, array, Date, Map, Set, RegExp, ArrayBuffer 및 일반 typed array를 지원하며,
structured clone이 `lastIndex`를 초기화하므로 모든 RegExp는 `lastIndex`가 `0`일 때만 지원하며,
실행된 global 또는 sticky RegExp에서 이 제한이 주로 드러납니다.
공유 메모리, Buffer, 사용자 class instance, accessor와 symbol property는 명시적으로 거부합니다.

`ttlMs`를 생략한 in-flight reservation에는 워커 충돌로 인한 영구 교착을 막기 위해 30초 기본 리스가 적용됩니다.
명시적으로 `ttlMs`를 지정하면 해당 값이 in-flight 리스를 결정하고, 완료·실패 레코드의 보존 기간은 기존처럼 생략 시
만료되지 않습니다. in-flight reservation은 `expiresAt` 직전까지만 완료할 수 있습니다. 만료 시각부터 `commit`과 `fail`은
`IdempotencyReservationExpiredProblem`으로 거부되며, 새 `reserve`가 발급한 reservation만 상태를 전이할 수 있습니다.

handler가 실패하면 첫 호출은 원래 오류를 throw하고, 비재시도 실패는 같은 key의 후속 호출에서 handler를 실행하지 않고
`outcome: "failed"`와 이전 `record.problem`을 반환합니다. `ttlMs`를 지정하면 만료 후 다시 실행할 수 있으며, 생략하면
실패 레코드를 만료시키기 전까지 보존합니다.

재시도 여부는 요청의 `isRetryable(error)` 정책, 오류의 boolean `retryable`, 오류의 HTTP `status` 순서로 결정합니다.
기본적으로 408·429를 제외한 4xx는 비재시도 실패이며, 5xx와 재시도 정보가 없는 오류는 기존처럼 재시도할 수 있습니다.
도메인 오류나 외부 SDK 오류는 `coordinator.execute({ key, isRetryable: (error) => ... }, handler)`로 분류할 수 있습니다.
이 정책은 handler 실패에만 적용하며, 예약 감사와 commit 실패는 기존 복구 동작을 유지합니다. 정책 함수가 throw하면
원래 handler 오류에 `idempotencyFailureRecordError`로 첨부되고 실패 레코드는 기록되지 않습니다.

handler가 성공한 뒤 `commit`이 실패하면 coordinator는 같은 reservation을 `retryable: false` failed 상태로 전이하고 원래
commit 오류를 다시 throw합니다. 이후 같은 key 호출은 handler를 다시 실행하지 않고
`IdempotencyExecutionIndeterminateProblem`으로 실패합니다. 이 상태는 handler의 부수효과가 이미 완료됐을 수 있지만
응답을 저장하지 못했음을 뜻하므로, 같은 key를 재시도하지 말고 외부 시스템을 조회해 복구해야 합니다. 저장은 완료됐지만
완료 응답이 유실된 경우처럼 store가 이미 completed 상태라면 failed 전이는 보조 진단으로 남고, 다음 호출은 저장된 응답을
replay합니다. failed 전이도 실패하면 원래 commit 오류를 유지하면서 보조 오류를 `idempotencyFailureRecordError` 진단으로
첨부하며, store 상태는 운영자가 확인해야 합니다.

`ttlMs`는 생략하거나 유효한 날짜 범위 안의 양의 정수 밀리초로 지정해야 합니다. `0`, 음수, 소수, `NaN`, 무한대 또는 날짜 범위를 넘는 값은 저장소 상태를 변경하기 전에 `InvalidIdempotencyTtlProblem`으로 실패합니다.

## 통합 키 헬퍼

```ts
import {
  deriveEventConsumerIdempotencyKey,
  deriveTaskIdempotencyKey,
  deriveWebhookIdempotencyKey,
} from "@croco/idempotency-core";

const webhookKey = deriveWebhookIdempotencyKey({
  provider: "stripe",
  eventId: "evt_123",
  tenantId: "tenant-a",
});

const taskKey = deriveTaskIdempotencyKey({
  taskName: "invoice.send",
  taskId: "job-123",
  tenantId: "tenant-a",
  payloadFingerprint: "sha256:payload",
});

const eventKey = deriveEventConsumerIdempotencyKey({
  consumerName: "billing-projection",
  eventId: "event-123",
  eventType: "invoice.created",
  tenantId: "tenant-a",
});
```

## Store conformance

저장소 어댑터는 `createIdempotencyStoreConformanceSuite()`가 반환하는 case를 자체 테스트 러너에서 실행해 replay,
in-flight, conflict, tenant scope, expiration 동작을 검증할 수 있습니다. conformance는 completed 레코드가 이전
reservation의 `fail` 호출로 덮어써지지 않고 기존 응답을 계속 replay하는지도 검증합니다.

```ts
import { createIdempotencyStoreConformanceSuite } from "@croco/idempotency-core";

const suite = createIdempotencyStoreConformanceSuite({
  createStore: () => new MyDurableIdempotencyStore(),
});

for (const testCase of suite.cases) {
  it(testCase.name, testCase.run);
}
```

## API 요약

- `deriveIdempotencyKey()`: explicit key, request fingerprint, provider event id, tenant-scoped key를 공통 `DerivedIdempotencyKey`로 정규화합니다.
- `deriveHttpIdempotencyKey()`, `deriveWebhookIdempotencyKey()`, `deriveTaskIdempotencyKey()`, `deriveEventConsumerIdempotencyKey()`: 런타임별 key helper입니다.
- `IdempotencyStore`: `reserve`, `commit`, `replay`, `fail`, `expire` 저장소 계약입니다.
- `IdempotencyCoordinator`: 저장소 계약 위에서 execute/replay/in-flight/failure 결과를 통합합니다.
- `InMemoryIdempotencyStore`: conformance와 로컬 개발에 사용할 수 있는 reference store입니다.
- `IdempotencyConflictProblem`: 동일 key와 다른 fingerprint 충돌을 표준 Problem으로 표현합니다.
- `IdempotencyExecutionIndeterminateProblem`: handler 실행 뒤 응답 저장이 실패해 같은 key를 재시도할 수 없는 상태를 표준 Problem으로 표현합니다.
- `IdempotencyReservationExpiredProblem`: 만료된 reservation의 완료 시도를 안전한 진단 시각과 함께 표현합니다.
- `InvalidIdempotencyTtlProblem`: 잘못된 TTL과 위반한 validation constraint를 표준 Problem으로 표현합니다.
- `InvalidIdempotencySnapshotProblem`: in-memory snapshot으로 보존할 수 없는 응답 또는 metadata를 표준 Problem으로 표현합니다.

## 라이선스

Apache-2.0
