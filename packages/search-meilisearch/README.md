# @croco/search-meilisearch

Meilisearch를 `@croco/search-core` 검색 엔진 인터페이스에 연결하는 패키지입니다.

## 설치

```bash
pnpm add @croco/search-meilisearch meilisearch
```

## 사용법

```typescript
import { Context } from "@croco/framework-context";
import { MeilisearchEngine } from "@croco/search-meilisearch";

const engine = new MeilisearchEngine({
  host: process.env.MEILISEARCH_HOST!,
  apiKey: process.env.MEILISEARCH_API_KEY!,
  tenantTokenOptions: {
    apiKeyUid: "tenant-search",
    expiresIn: 3600,
  },
});

await Context.run({ requestId: "req-1", tenantId: "tenant-1" }, async () => {
  await engine.createIndex({
    name: "products",
    filterableFields: ["category"],
    searchableFields: ["name"],
  });
  await engine.indexDocument("products", {
    id: "p1",
    tenantId: "tenant-1",
    category: "apparel",
    name: "Croco Hoodie",
  });
  const result = await engine.search("products", {
    filters: { category: "apparel" },
    query: "hoodie",
  });
});
```

## API 레퍼런스

| API                                   | 설명                                                               |
| ------------------------------------- | ------------------------------------------------------------------ |
| `MeilisearchEngine`                   | 검색, 인덱싱, 삭제, 인덱스 생성, tenant token 발급을 담당합니다.   |
| `MeilisearchDiagnosticsProvider`      | 설정과 optional live readiness를 secret 없이 진단합니다.           |
| `MeilisearchEngineOptions`            | host, apiKey, tenant token, task 대기 옵션을 지정합니다.           |
| `MeilisearchDeleteIndexOptions`       | 시스템 호출의 물리 인덱스 삭제 허용 여부와 취소 신호를 지정합니다. |
| `TenantTokenOptions`                  | tenant token용 API key UID와 만료 시간을 지정합니다.               |
| `MissingMeilisearchConfigProblem`     | host/API key 설정 누락을 나타냅니다.                               |
| `MeilisearchInvalidRequestProblem`    | 안전하지 않은 필터/정렬 필드, 빈 index/document id를 나타냅니다.   |
| `MeilisearchIndexNotFoundProblem`     | upstream index-not-found를 안정적인 Problem으로 정규화합니다.      |
| `MeilisearchRetryableUpstreamProblem` | timeout/429/5xx 등 재시도 가능한 upstream 장애를 나타냅니다.       |
| `MeilisearchTaskCanceledProblem`      | 취소된 비동기 task를 non-retryable Problem으로 보고합니다.         |
| `MeilisearchTerminalUpstreamProblem`  | 인증 실패 등 terminal upstream 장애를 나타냅니다.                  |
| `TenantTokenNotConfiguredProblem`     | tenant token 옵션 없이 토큰 발급을 시도할 때 발생합니다.           |

## 동작 메모

- 모든 검색과 인덱싱은 현재 `Context.getTenantId()` 값을 `_tenantId` 필드에 반영합니다.
- tenant token은 요청한 tenant가 현재 `Context.getTenantId()`와 일치할 때만 `_tenantId` 필터 규칙을 포함해 생성됩니다.
- 검색·문서 작업·tenant token 발급에는 tenant 정보가 필요하며, 없으면 `MissingTenantProblem`이 발생합니다.
- `deleteIndex`는 테넌트 컨텍스트에서 `MeilisearchInvalidRequestProblem`으로 실패하며 어떤 문서도 삭제하지 않습니다.
  물리 인덱스 삭제는 테넌트가 없는 시스템 관리 코드에서 `engine.deleteIndex(name, { allowGlobalDrop: true })`로
  명시적으로 요청해야 합니다. 이 옵션은 테넌트 컨텍스트의 삭제 제한을 해제하지 않습니다. 기존 시스템 호출도
  이 옵션을 지정해야 하며, 애플리케이션은 해당 호출에 대한 관리자 권한을 검증해야 합니다.
- 모든 engine I/O 메서드는 `options.signal`을 Meilisearch 요청과 task polling에 전달합니다. 취소되면 SDK polling 간격을
  기다리지 않고 `search-core/operation-aborted` Problem으로 실패합니다.
- 검색, 결정적 문서 upsert·삭제, settings 갱신, task polling의 일시적 네트워크·429·5xx 실패는 최대 3회
  시도합니다. 기본 backoff는 `@croco/retry-core` 정책을 사용하며 `retryBackoff`로 조정할 수 있습니다.
  index 생성·삭제와 tenant token 발급은 재실행하지 않습니다.
- `createIndex`, `indexDocument`, `bulkIndex`, `deleteDocument`, `deleteIndex`는 기본적으로
  Meilisearch task 완료를 기다린 뒤 resolve합니다. 필요하면 `taskWait.enabled: false`로
  enqueue-only 동작을 선택할 수 있습니다. 대기 중 task가 취소되면 영향을 받은 operation,
  index, document 문맥을 포함한 `MeilisearchTaskCanceledProblem`으로 실패합니다.
- 필터와 정렬 필드는 `A-Z`, `a-z`, 숫자, `_`, `.`, `-`만 허용합니다. 문자열 필터 값은
  quote/backslash를 escape해 tenant filter injection을 막습니다.

## 공유 인덱스의 문서 키와 마이그레이션

`id`는 호출자가 사용하는 원본 문서 ID입니다. 저장 시 `_crocoDocumentId`에 현재 테넌트와 `id`의
JSON 배열을 SHA-256으로 해시하고, 모든 비트를 `-`와 `_`로 표현한 256자 내부 기본 키를 기록합니다.
두 문자는 Meilisearch 기본 토크나이저의 구분자이므로 내부 키가 전체 필드 검색에 단어를 추가하지 않습니다.
외부에서 `nonSeparatorTokens`를 변경하는 경우에는 검색 필드를 명시해 내부 키를 제외해야 합니다.
이 필드는 엔진 소유이며 입력값을 덮어쓰고
엔진 검색 결과에서는 제거합니다. 원본 `id` 필터·정렬과 테넌트 필터를 포함한 삭제는 그대로 동작합니다.
테넌트 토큰으로 Meilisearch를 직접 조회하면 내부 필드도 반환될 수 있지만 `id`는 원본 값입니다.

인덱스는 쓰기 전에 `engine.createIndex`로 생성해야 합니다. `primaryKey`는 생략하거나 `"id"`만 지정할 수
있으며 실제 Meilisearch 기본 키는 `_crocoDocumentId`입니다. 각 쓰기는 인덱스 메타데이터를 조회해 이
계약을 검사하므로 writer API key에는 문서 쓰기 권한과 `indexes.get` 권한이 필요합니다.
기존 `id` 또는 사용자 지정 기본 키 인덱스에 쓰면
`search-meilisearch/invalid-request`와 `upstreamCode: "incompatible-primary-key"`로 실패합니다.
인덱스가 없으면 index-not-found Problem으로 실패합니다. `taskWait.enabled: false`로 인덱스를
생성하는 호출자는 생성 task 완료를 확인한 뒤 첫 문서를 써야 합니다.

업그레이드 시 새 이름의 인덱스를 `createIndex`로 만들고, 원본 데이터 저장소에서 **모든 테넌트**의
문서를 각 테넌트 컨텍스트로 재색인한 뒤 조회·쓰기 대상을 전환하세요. 이전 버전 writer를 먼저 중지하고,
전환 전후 테넌트별 문서 수와 조회·삭제 격리를 확인해야 합니다. 기존 인덱스는 자동으로 변경하거나 삭제하지
않습니다. 이미 덮어써진 검색 문서는 이 패치만으로 복구되지 않으므로 원본 데이터가 필요합니다.

## 런타임과 설정

| 항목                  | 값                                                             |
| --------------------- | -------------------------------------------------------------- |
| Runtime               | Node.js, Lambda                                                |
| Required env          | `MEILISEARCH_HOST`, `MEILISEARCH_API_KEY`                      |
| Optional tenant token | `tenantTokenOptions.apiKeyUid`, `tenantTokenOptions.expiresIn` |

`MeilisearchDiagnosticsProvider`는 설정 존재 여부만 boolean으로 노출하고 raw host/API key를
출력하지 않습니다. Live readiness는 명시적으로 `readinessCheck`를 넘겼을 때만 실행됩니다.

```typescript
import { MeilisearchDiagnosticsProvider } from "@croco/search-meilisearch";

const diagnostics = new MeilisearchDiagnosticsProvider(
  {
    host: process.env.MEILISEARCH_HOST,
    apiKey: process.env.MEILISEARCH_API_KEY,
  },
  {
    readinessCheck: async ({ client }) => {
      await client.health();
      return { details: { reachable: true } };
    },
  },
);

const health = await diagnostics.getHealth();
```

## 검증

Default tests do not require a live Meilisearch service:

```bash
pnpm --filter @croco/search-meilisearch test
```

Optional live smoke runs only when both env vars are present:

```bash
MEILISEARCH_HOST=http://localhost:7700 \
MEILISEARCH_API_KEY=masterKey \
pnpm --filter @croco/search-meilisearch test:live
```
