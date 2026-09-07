# @croco/notifications-resend

Resend를 이용해 이메일 알림을 전송하는 `@croco/notifications-core` 구현체입니다.

## 설치

```bash
pnpm add @croco/notifications-resend resend
```

## 사용법

```typescript
import { ResendProvider } from "@croco/notifications-resend";

const apiKey = process.env.RESEND_API_KEY;
if (!apiKey) {
  throw new Error("RESEND_API_KEY is required");
}

const provider = new ResendProvider({
  apiKey,
  from: "noreply@example.com",
});

const result = await provider.send(
  {
    to: "user@example.com",
    subject: "환영합니다",
    content: "<p>가입을 환영합니다.</p>",
  },
  { idempotencyKey: "welcome:user-123:v1" },
);
```

## 템플릿 전송

```typescript
await provider.send({
  to: "user@example.com",
  subject: "환영합니다",
  content: "<p>Croco님, 가입을 환영합니다.</p>",
  templateId: "welcome-email",
  templateVersion: "v1",
  locale: "ko-KR",
  variables: { name: "Croco" },
});
```

`@croco/notifications-resend`는 provider-native 템플릿 ID를 Resend에 그대로 전달하지 않습니다.
`@croco/notifications-core`에서 렌더링된 `content`를 Resend HTML 본문으로 전송하며,
`templateId`, `templateVersion`, `locale`은 dispatch/telemetry evidence로 보존합니다.

`ResendProvider.getCapabilities()`는 email, idempotency key, rendered template, consumer-managed outbox
프로필을 명시적으로 선언합니다. `NotificationProviderRegistry`는 등록 시 이 프로필의 provider 이름과
채널을 검증하며, dispatch는 추론된 기본값을 사용하지 않습니다.

## Runtime configuration

| 값                   | 필수 | 설명                                                     |
| -------------------- | ---- | -------------------------------------------------------- |
| `RESEND_API_KEY`     | ✅   | Resend API key. diagnostics 출력에서 redaction됩니다.    |
| default from address | ✅   | `ResendProvider` 생성자에 넘기는 기본 발신자 주소입니다. |
| `RESEND_FROM`        | ❌   | optional live smoke에서 기본 발신자 주소로 사용합니다.   |
| `RESEND_SMOKE_TO`    | ❌   | optional live smoke의 수신자 주소입니다.                 |
| `CROCO_LIVE_RESEND`  | ❌   | `true`일 때만 optional live smoke가 실행됩니다.          |

생성자는 `apiKey`와 `from`이 비어 있거나 발신자 주소 형식이 잘못되면 Croco Problem으로 실패합니다.
`send()`는 수신자 주소가 잘못되면 Resend API를 호출하지 않고
`notifications-resend/validation-failed` 결과를 반환합니다.

## Diagnostics and readiness

```typescript
import { ResendDiagnosticsProvider } from "@croco/notifications-resend";

const diagnostics = new ResendDiagnosticsProvider({
  apiKey: process.env.RESEND_API_KEY,
  from: "noreply@example.com",
});

const health = await diagnostics.getHealth();
```

기본 diagnostics는 Resend 네트워크 요청을 보내지 않습니다. 설정 존재 여부, 기본 발신자 domain,
missing config, live check 상태만 반환하며 API key 원문은 노출하지 않습니다. 실제 upstream readiness가
필요하면 `readinessCheck`를 주입하고, 반환되는 details의 token/secret/api key/idempotency key 계열
값은 redaction됩니다.

## Failure modes and recovery

| Problem code                                | 의미                                                             | 복구 액션                                                       |
| ------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------- |
| `notifications-resend/missing-config`       | API key 또는 기본 발신자 설정이 없습니다.                        | env/config를 설정하고 diagnostics를 다시 확인합니다.            |
| `notifications-resend/validation-failed`    | 수신자, 발신자, 또는 provider 요청이 잘못됐습니다.               | 주소/템플릿 렌더링 결과를 수정합니다.                           |
| `notifications-resend/idempotency-conflict` | Resend가 idempotency key 재사용을 거부했습니다.                  | 같은 key로 다른 payload를 보내지 않도록 고칩니다.               |
| `notifications-resend/retryable-upstream`   | 429, 5xx, 네트워크 timeout 등 재시도 가능한 upstream 실패입니다. | 같은 idempotency key로 재시도하거나 provider 상태를 확인합니다. |
| `notifications-resend/terminal-upstream`    | 인증 실패 등 재시도로 해결되지 않는 upstream 실패입니다.         | API key, domain, sender verification을 확인합니다.              |

Provider telemetry는 `notifications.resend.send.accepted`,
`notifications.resend.send.retryable_failure`, `notifications.resend.send.failed` event를 기록합니다.
event에는 provider, channel, idempotency key 존재 여부/source, template 존재 여부, Problem code/category만
남기며 API key, idempotency key 원문, 수신자, 제목, 본문은 기록하지 않습니다.

## Optional live smoke

기본 테스트는 live Resend credential을 요구하지 않습니다. 실제 provider smoke를 실행하려면 안전한
수신자와 발신자를 명시하고 opt-in 합니다.

```bash
CROCO_LIVE_RESEND=true \
RESEND_API_KEY=re_... \
RESEND_FROM=noreply@example.com \
RESEND_SMOKE_TO=smoke-recipient@example.com \
pnpm --filter @croco/notifications-resend test -- ResendLiveSmoke
```

이 smoke는 지정된 수신자에게 한 통의 HTML 이메일을 보내고 Resend message id가 반환되는지 확인합니다.

## API 레퍼런스

| API                         | 설명                                                                         |
| --------------------------- | ---------------------------------------------------------------------------- |
| `ResendProvider`            | 단건 전송과 배치 전송을 처리합니다.                                          |
| `ResendDiagnosticsProvider` | 설정 상태와 선택적 readiness check를 redaction된 diagnostics로 노출합니다.   |
| `ResendConfig`              | API 키와 발신자 주소를 지정하는 설정 타입입니다.                             |
| `Resend*Problem`            | 설정, 검증, idempotency, upstream 실패를 안정적인 Problem code로 표현합니다. |

`ResendNotificationProblem`은 이전 catch-all 실패 타입과의 호환을 위해 export되지만,
새 provider send path는 구체적인 `notifications-resend/*` Problem code를 반환합니다.

## 동작 메모

- 재시도 대상 오류는 408, 425, 429, 5xx와 일부 네트워크 오류입니다.
- 실패 결과는 `success: false`와 정규화된 `problem`을 함께 반환하며, 호출자는 해당 Problem의
  `extensions.retryable`을 사용해 재시도 가능성을 분류할 수 있습니다.
- `content`를 Resend HTML 본문으로 보냅니다. 템플릿 렌더링은 `@croco/notifications-core`에서 수행합니다.
- 모든 요청은 idempotency key를 붙여 전송합니다. `send()`는 `options.idempotencyKey`를 우선 사용하고,
  옵션에 key가 없으면 문자열인 `payload.metadata.idempotencyKey`를 사용합니다. 둘 다 없으면 기존처럼 고유 key를 생성합니다.
- `sendBatch()` 재시도 시 중복 발송을 방지하려면 각 payload의 `metadata.idempotencyKey`에 메시지별로 고유하고
  재시도 간 유지되는 key를 지정해야 합니다. 배열 순서가 바뀌어도 각 메시지의 key는 그대로 사용됩니다.
  key를 지정하지 않은 배치를 다시 호출하면 새 key가 생성되므로 호출 간 중복 발송은 방지되지 않습니다.

---

## 성숙도 안내

| 항목                 | 상태                                                                            | 설명                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **현재 상태**        | 🔴 alpha                                                                        | 개발 중, 사용 시 주의 필요                                                                               |
| **주요 기능**        | 단건 전송, 렌더링 템플릿 전송, 재시도, 멱등성, diagnostics, optional live smoke | Resend API 기본 연동과 readiness evidence                                                                |
| **테스트 존재 여부** | ✅                                                                              | 단위테스트, diagnostics, env-gated live smoke (`ResendProvider.spec.ts`, `ResendLiveSmoke.spec.ts`)      |
| **운영 증거 수준**   | L2                                                                              | credential 없는 mocked conformance와 readiness diagnostics 있음 / live Resend smoke는 env-gated optional |

### 참고

- `@croco/notifications-core` 인터페이스를 구현합니다.
- 모든 요청에 고유 idempotency key를 적용합니다.
- 템플릿 미사용 시 HTML 본문으로 전송합니다.
- production-ready 승격에는 기본 테스트와 diagnostics 통과 외에도 실제 Resend credential로 수행한
  optional live smoke evidence가 필요합니다. package catalog maturity는 해당 evidence가 확인되기
  전까지 alpha로 유지합니다.
