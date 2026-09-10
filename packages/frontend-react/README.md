# @croco/frontend-react

> Croco Presentation adapter — Host 생명주기, Transport 프로토콜 실행, Build Target 산출물 계약과 독립적으로 조합됩니다.

React 앱에서 Croco의 SSR 기능을 사용하기 위한 유틸리티 패키지입니다.

이 패키지는 React 앱에서 `@croco/meta-vite`와 함께 Croco의 SSR 데이터 전송 기능을 사용하기 위한 훅과 설정 함수를 제공합니다.
또한 generated client나 앱별 auth provider가 반환한 세션, 테넌트, 권한, 엔터틀먼트 상태를
React에서 명시적으로 표현하는 provider-neutral bridge를 제공합니다.

## 런타임 증거

이 패키지의 beta runtime claim은 package test와 generated-app smoke가 함께 검증합니다.

- `pnpm --filter @croco/frontend-react test`는 `PageDataProvider`, page data access hooks, `usePageMeta`,
  auth bridge, Problem UI primitive를 React render path에서 검증합니다.
- `pnpm create-croco-app:smoke meta-vite-web meta-vite-fullstack-workers`는 generated
  meta-vite 앱에서 `PageDataProvider`/required page data 흐름, meta 전달, hydration root,
  그리고 Cloudflare Worker fullstack smoke를 검증합니다.
- API reference는 `packages/docs/src/content/docs/api/frontend-react/`에서 생성됩니다.

## 설치

```bash
pnpm add @croco/frontend-react
```

## 사용법

### 페이지 설정

각 페이지의 meta-vite route 또는 generated page config에서 기본 설정을 사용합니다:

```typescript
// pages/index/route.ts
import { createCrocoPageConfig } from "@croco/frontend-react";

export default createCrocoPageConfig({ mode: "ssr", path: "/" });
```

### 데이터 전송

페이지 데이터를 전송하려면 `+data.ts`에서 함수를 정의합니다:

```typescript
// pages/index/+data.ts
import { type CrocoDataFn } from "@croco/frontend-react";

export const data: CrocoDataFn<{ message: string }> = async () => {
  return {
    message: "Hello from SSR!",
  };
};
```

### React에서 데이터 사용

`usePageData` 훅은 provider 또는 data가 없는 상태를 `undefined`로 드러냅니다:

```typescript
// pages/index/+Page.tsx
import { usePageData } from '@croco/frontend-react';

export default function Page() {
  const data = usePageData<{ message: string }>();

  if (!data) {
    return <div role="alert">Page data unavailable</div>;
  }

  return <div>{data.message}</div>;
}
```

SSR/hydration 경계에서 data가 반드시 있어야 하는 컴포넌트는 `useRequiredPageData`를 사용합니다.
누락 시 `PageDataUnavailableProblem`이 provider와 data 설정을 확인하라는 복구 메시지와 함께 발생합니다:

```typescript
import { useRequiredPageData } from '@croco/frontend-react';

export default function Page() {
  const data = useRequiredPageData<{ message: string }>();

  return <div>{data.message}</div>;
}
```

신뢰할 수 없는 hydration payload는 schema library와 구조적으로 호환되는 parser를 전달해 검증합니다.
data가 없으면 parser를 호출하지 않고 `undefined`를 반환하며, parser가 던진 validation failure는 그대로 전파합니다:

```typescript
import { useParsedPageData } from '@croco/frontend-react';

declare const pageDataSchema: {
  parse(input: unknown): { message: string };
};

export default function ParsedPage() {
  const data = useParsedPageData(pageDataSchema);

  if (!data) {
    return <div role="alert">Page data unavailable</div>;
  }

  return <div>{data.message}</div>;
}
```

### meta-vite profile assumptions

`@croco/frontend-react`의 SSR 데이터 훅은 `@croco/meta-vite`가 렌더링한 React 페이지에서
`PageDataProvider`로 전달된 page context를 읽는 경계만 담당합니다. Route registration,
`RenderServer`, Vite plugin, Cloudflare Worker/Lambda adapter wiring은 generated profile 또는
앱의 `@croco/meta-vite` 설정이 소유합니다.

현재 package/runtime evidence는 아래 profile을 기준으로 합니다:

- package test: `pnpm --filter @croco/frontend-react test`
  - optional/required/parsed page data hooks와 `usePageMeta`가 React render path에서 page data와 meta를
    노출하는지 검증합니다.
  - `createCrocoPageConfig`가 `@croco/meta-vite`의 mode, path, head, 초 단위 revalidate 계약을
    route registration 경계까지 손실 없이 전달하는지 검증합니다.
- generated fullstack smoke: `CROCO_GENERATED_SMOKE_CASES=meta-vite-fullstack-workers pnpm create-croco-app:smoke`
  - `ddd-vike-fullstack` compatibility preset name과 `--frontend-deploy cloudflare-meta-vite`
    generated profile에서 `@croco/meta-vite` page/API/action/ISR smoke를 실행합니다.
    해당 preset 이름은 legacy 호환성 이름이며, 현재 SSR/RSC runtime은 `@croco/meta-vite`입니다.
  - `react-dom/server` + `react-dom/client` + generated DOM harness로 browser hydration을 검증하고,
    `PageDataProvider`로 전달된 page data가 hydration 후 DOM에 남는지 확인합니다.
  - stale server markup과 client page data mismatch가 `onRecoverableError`로 드러나는지 검증해,
    client-side hydration failure를 성공처럼 처리하지 않습니다.

Unsupported states:

- `PageDataProvider` 없이 `usePageData<T>()` 또는 `useParsedPageData(parser)`를 호출하면 `undefined`를
  반환합니다. `useRequiredPageData<T>()`는 `PageDataUnavailableProblem`을 던집니다. 앱은 누락 상태를
  성공 data payload로 취급하지 않아야 합니다.
- 이 패키지는 직접 DOM을 만들거나 `hydrateRoot`를 호출하지 않습니다. Browser hydration bootstrap은
  generated app entrypoint 또는 앱별 `@croco/meta-vite` runtime wiring에서 소유해야 합니다.
- `createCrocoPageConfig`는 `path`를 canonical route config에 포함합니다. 이 config를
  `@croco/meta-vite` `defineRoute()` 또는 generated route manifest 입력에 그대로 결합해야 합니다.
- 검증된 generated profile 밖에서 custom Vite/React adapter를 조합하는 경우, 동일한 hydration
  mismatch visibility check를 앱 smoke에 추가한 뒤 runtime claim을 확장해야 합니다.

### Auth / entitlement bridge

generated client나 앱 provider에서 읽은 상태를 `CrocoAuthBridgeProvider`에 전달하면
권한/엔터틀먼트 gate가 loading, allowed, denied, unauthenticated, unavailable 상태를
성공 렌더링과 분리합니다.

```typescript
import {
  CrocoAuthBridgeProvider,
  RequireEntitlement,
  RequirePermission,
  createFrontendAuthBridgeState,
} from "@croco/frontend-react";

async function loadBridgeState() {
  const [session, tenant, permissions, entitlements] = await Promise.all([
    generatedClient.auth.session(),
    generatedClient.tenant.current(),
    generatedClient.access.permissions(["billing:read"]),
    generatedClient.entitlements.check(["billing.pro"]),
  ]);

  return createFrontendAuthBridgeState({
    session,
    tenant,
    permissions,
    entitlements,
    providerName: "generated-client",
  });
}

export function BillingRoute({ bridgeState }: { bridgeState: Awaited<ReturnType<typeof loadBridgeState>> }) {
  return (
    <CrocoAuthBridgeProvider value={bridgeState}>
      <RequirePermission permissions="billing:read" tenantRequired>
        <RequireEntitlement entitlements="billing.pro">
          <BillingDashboard />
        </RequireEntitlement>
      </RequirePermission>
    </CrocoAuthBridgeProvider>
  );
}
```

Denied and unavailable states preserve Croco Problem Details plus optional recovery actions,
so apps can show sign-in, request-access, or retry actions without treating unknown state as success.

### Problem UI primitives

Croco Problem Details can be rendered without collapsing diagnostic evidence into a generic string.
`ProblemPanel` displays the RFC 7807 fields and typed recovery actions, `ProblemBoundary`
normalizes thrown Croco Problems, unknown thrown values, and external `Error` objects, and
`ProblemToastAdapter` maps the same model to provider-specific toast libraries.

```typescript
import type { ReactNode } from "react";
import type { ProblemDetails } from "@croco/problems-core";
import {
  ProblemBoundary,
  ProblemPanel,
  type ProblemRecoveryAction,
} from "@croco/frontend-react";

declare function refetch(): Promise<void>;

const recoveryActions: readonly ProblemRecoveryAction[] = [
  { id: "retry", kind: "retry", label: "Retry", onRecover: () => refetch() },
  { href: "/support", id: "support", kind: "contactSupport", label: "Contact support" },
];

export function ProblemState({ problem }: { problem: ProblemDetails }) {
  return <ProblemPanel problem={problem} recoveryActions={recoveryActions} />;
}

export function AppBoundary({ children }: { children: ReactNode }) {
  return (
    <ProblemBoundary recoveryActions={recoveryActions}>
      {children}
    </ProblemBoundary>
  );
}
```

## API

### `createCrocoPageConfig(options?)`

meta-vite page route의 canonical config를 생성합니다. 반환값은 `defineRoute()` 입력과 직접 결합할 수 있으며,
ISR 재검증 시간은 `revalidateSeconds`로 받아 meta-vite의 초 단위 `revalidate`에 그대로 전달합니다.

**옵션:**

- `mode?: "ssr" | "ssg" | "isr" | "rsc"` - render mode (재검증 주기가 있으면 `"isr"`, 없으면 `"ssr"`; 명시한 mode가 우선)
- `path?: string` - route path
- `head?: () => HeadMetadata` - title, description, OpenGraph title, canonical URL metadata
- `revalidateSeconds?: number` - ISR 재검증 주기(초)

기존 `ssr` boolean과 밀리초 단위 `revalidate` 입력은 deprecated입니다. 재검증 주기 없이 사용하는
`ssr: false`는 `mode: "ssg"`로,
`revalidate: 60_000`은 `revalidateSeconds: 60`으로 이전하세요. Deprecated 입력은 canonical 입력과 함께
사용할 수 없으며, helper는 밀리초 값을 초로 한 번 변환한 뒤 반환합니다. `revalidate`가 있으면
`ssr` 값과 관계없이 `"isr"` 모드를 사용합니다.

**반환값:**

```typescript
{
  path?: string;
  mode: "ssr" | "ssg" | "isr" | "rsc";
  head?: () => {
    title?: string;
    description?: string;
    ogTitle?: string;
    canonical?: string;
  };
  revalidate?: number;
}
```

### `usePageData<T>()`

`PageDataProvider`로 전달된 SSR page data에 선택적으로 접근합니다. 이 훅은 payload를 검증하지 않습니다.

**제네릭:**

- `T` - 페이지 데이터 타입 (기본값: `unknown`)

**반환값:** `T | undefined`

### `useRequiredPageData<T>()`

provider의 `data`가 반드시 존재해야 하는 SSR/hydration 경계에서 사용합니다. data가 없으면
`PageDataUnavailableProblem`을 던지고, 있으면 `T`로 반환합니다. 이 훅은 payload를 검증하지 않습니다.

**반환값:** `T`

### `useParsedPageData<T>(parser)`

`{ parse(input: unknown): T }` 구조의 parser로 page data를 검증합니다. data가 있을 때만 parser를 호출하고,
validation failure를 변환하거나 숨기지 않습니다.

**반환값:** `T | undefined`

### `useSessionGate(requirements?)`

현재 bridge 상태를 session gate union으로 평가합니다. 반환 상태는
`loading`, `allowed`, `denied`, `unauthenticated`, `unavailable` 중 하나입니다.
permission, entitlement, tenant requirement가 없는 session-only gate는 optional tenant provider의
loading/unavailable 상태와 독립적으로 평가됩니다. tenant-dependent requirement는 기존 tenant 상태를 계속 반영합니다.

### `useTenant()`

현재 tenant 상태를 `loading`, `available`, `missing`, `unavailable` union으로 반환합니다.

### `useEntitlements(entitlements, options?)`

요청된 엔터틀먼트 키를 gate union으로 평가합니다. provider failure와 denied Problem Details를
그대로 보존합니다.
인자 없이 호출하면 현재 provider가 전달한 raw entitlement state를 반환합니다.

### `ProblemPanel({ problem, recoveryActions, renderProblem })`

`ProblemDetails`의 `code`, `title`, `detail`, `status`, `instance`를 접근 가능한 패널로 렌더링합니다.
`renderProblem`과 `renderRecoveryAction`은 원본 `ProblemDetails`와 `ProblemRecoveryAction`을 그대로 받아
앱별 UI로 대체할 수 있습니다.

### `ProblemBoundary`

React 자식 트리에서 던져진 Croco Problem, plain Problem Details, 외부 `Error`, unknown 값을
`ProblemDetails`로 정규화하고 fallback 또는 `ProblemPanel`로 렌더링합니다.

### `ProblemToastAdapter`

toast 라이브러리에 넘길 수 있는 `{ title, description, code, status, problem, recoveryActions }`
payload를 생성합니다.

## 타입

### `CrocoPageContext`

페이지 컨텍스트 타입입니다.

```typescript
export type CrocoPageContext = {
  urlOriginal: string;
  data?: unknown;
  title?: string;
  description?: string;
  env?: Record<string, unknown>;
};
```

### `CrocoDataFn<T>`

페이지 데이터 전송 함수 타입입니다.

```typescript
export type CrocoDataFn<T = unknown> = (pageContext: CrocoPageContext) => Promise<T> | T;
```

### `FrontendAuthBridgeState`

```typescript
export type FrontendAuthBridgeState = {
  session: FrontendSessionState;
  tenant: FrontendTenantState;
  permissions: FrontendPermissionState;
  entitlements: FrontendEntitlementState;
};
```

## 라이선스

Apache-2.0
