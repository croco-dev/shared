# @croco/frontend-vite

> Croco Presentation adapter — Host 생명주기, Transport 프로토콜 실행, Build Target 산출물 계약과 독립적으로 조합됩니다.

Croco Presentation 계층의 Vite 통합 helper 패키지입니다.

이 패키지는 SPA browser build와 Cloudflare Workers 대상 Vite 설정 helper를 제공합니다.
SSR/RSC route runtime, route manifest, server actions는 `@croco/meta-vite`가 소유합니다.
Vike runtime 통합은 제공하지 않습니다. `create-croco-app`의 Vike 이름 preset은
기존 자동화 호환성을 위한 legacy 이름이며, 현재 생성물은 `@croco/meta-vite` runtime을 사용합니다.

## 런타임 증거

이 패키지의 beta runtime claim은 Vite config helper와 generated browser output을 함께
검증합니다.

- `pnpm --filter @croco/frontend-vite test`는 `crocoSpaViteConfig()`,
  `createCrocoSpaViteConfig()`, `crocoVitePlugin()`, 그리고 optional
  `@cloudflare/vite-plugin` diagnostic을 검증합니다.
- `pnpm package-entrypoints:smoke`는 `cloudflare: false` 경로가 Cloudflare optional peer 없이
  import 가능하고, 기본 Cloudflare 경로의 누락 peer가 Croco Problem으로 실패하는지 검증합니다.
- `pnpm create-croco-app:smoke graphql-vite-spa-docker meta-vite-web meta-vite-fullstack-workers`
  는 SPA, meta-vite, fullstack Worker generated app의 Vite config load와 browser build output을
  검증합니다.
- API reference는 `packages/docs/src/content/docs/api/frontend-vite/`에서 생성됩니다.

## 설치

```bash
pnpm add @croco/frontend-vite
```

Cloudflare 통합을 사용하는 기본 설정(`crocoVitePlugin()`)에는 선택적 peer dependency인 `@cloudflare/vite-plugin`도 필요합니다:

```bash
pnpm add @cloudflare/vite-plugin
```

Cloudflare 통합을 사용하지 않는 Vite 설정은 `cloudflare: false`를 지정하면 `@cloudflare/vite-plugin` 없이도 패키지 엔트리포인트를 import할 수 있습니다.
기본 설정에서 선택적 peer가 누락되면 `frontend-vite/missing-cloudflare-vite-plugin` Problem으로 실패하며, 복구 방법은 peer 설치 또는 `cloudflare: false`입니다.

## 사용법

### Vite 설정

`vite.config.ts`에서 플러그인을 설정합니다:

```typescript
import { crocoVitePlugin } from "@croco/frontend-vite";

export default {
  plugins: crocoVitePlugin(),
};
```

### 옵션

```typescript
import { crocoVitePlugin } from "@croco/frontend-vite";

export default {
  plugins: crocoVitePlugin({
    ssr: true,
    cloudflare: true,
  }),
};
```

## API

### `crocoVitePlugin(options?)`

Cloudflare Workers 대상 Vite 통합 플러그인을 반환합니다.
SSR/RSC routes는 `@croco/meta-vite`의 Vite plugin과 generated route manifest가 소유합니다.

**옵션:**

- `ssr?: boolean` - SSR 활성화 여부 (기본값: `true`)
- `cloudflare?: boolean` - Cloudflare Workers 타겟 여부 (기본값: `true`)

**반환값:** `PluginOption[]` - Vite 플러그인 옵션 배열

## 타입

### `CrocoViteOptions`

플러그인 옵션 타입입니다.

```typescript
export type CrocoViteOptions = {
  ssr?: boolean;
  cloudflare?: boolean;
};
```

### `CrocoViteConfig`

플러그인 설정 타입입니다.

```typescript
export type CrocoViteConfig = {
  plugins: PluginOption[];
};
```

## 예제

### 기본 설정

```typescript
import { defineConfig } from "vite";
import { crocoVitePlugin } from "@croco/frontend-vite";

export default defineConfig({
  plugins: crocoVitePlugin(),
});
```

### SSR 비활성화

```typescript
import { defineConfig } from "vite";
import { crocoVitePlugin } from "@croco/frontend-vite";

export default defineConfig({
  plugins: crocoVitePlugin({ ssr: false }),
});
```

### Cloudflare 비활성화

```typescript
import { defineConfig } from "vite";
import { crocoVitePlugin } from "@croco/frontend-vite";

export default defineConfig({
  plugins: crocoVitePlugin({ cloudflare: false }),
});
```

## 검증

- `pnpm --filter @croco/frontend-vite test` — Vite config helper output, `cloudflare: false` peer exclusion, and missing optional Cloudflare peer diagnostics.
- `CROCO_GENERATED_SMOKE_CASES=graphql-vite-spa-docker,meta-vite-web,meta-vite-fullstack-workers pnpm create-croco-app:smoke` — SPA browser build output plus meta-vite and fullstack generated build/smoke coverage.

## 라이선스

Apache-2.0
