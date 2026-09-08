# DataLoader 설계 (Croco)

## 목표

- N+1 문제를 **요청 단위(per-request)**로 해결한다.
- GraphQL 뿐 아니라 REST에서도 동일한 최적화 이점을 얻을 수 있어야 한다.
- Croco의 역할 기반 아키텍처와 일관되게 맞춘다. 계약은 Contracts, 구체적인 연동은 Plugins로 구분하며 역할 메타데이터는 `docs/package-catalog.json`의 `packageRoles`를 따른다.
- 구현은 **옵트인(opt-in)** 이며, 모든 데이터 접근을 강제하지 않는다.

## 배경: N+1 문제란?

### GraphQL 예시 (User → Team → Organization)

쿼리:

```graphql
query {
  users {
    id
    team {
      id
      organization {
        id
      }
    }
  }
}
```

유저 100명인 경우:

- 배칭 없음
  - `getTeamById(teamId)`가 100회 호출
  - `getOrganizationById(orgId)`가 100회 호출
  - 총 200회의 I/O(DB/외부 API)
- 배칭 적용
  - `getTeamsByIds([..])` 1회
  - `getOrganizationsByIds([..])` 1회
  - 총 2회의 I/O

### REST에서도 같은 문제

예: `GET /users?include=team,organization`

서비스에서 유저 목록을 가져온 뒤, 각 유저의 team/org를 단건 조회하면 REST도 동일한 N+1이 발생한다.
따라서 최적화 지점이 GraphQL 리졸버에만 존재하면 REST는 혜택을 받지 못한다.

## 핵심 원리(외부 참고: Facebook DataLoader)

Facebook DataLoader의 핵심은 다음 2가지다.

1. **Batching(배칭)**: 같은 이벤트 루프 틱 내에 호출된 `load()`들을 큐에 모아 한 번에 `batchFn(keys)`로 플러시한다.
2. **Caching(캐싱)**: 동일한 키에 대한 중복 요청을 요청 범위 내에서 재사용한다.

### DataLoader의 중요한 제약(반드시 지켜야 함)

- `batchFn(keys)`는 **keys 길이와 동일한** 결과 배열을 반환해야 한다.
- 결과 배열의 **순서**는 입력 keys의 순서와 1:1로 매핑되어야 한다.
  - 예: DB의 `WHERE IN`은 순서를 보장하지 않으므로, 반드시 키 기준으로 재정렬해야 한다.
- 특정 키에 결과가 없으면 해당 인덱스에 `null` 또는 `Error`를 명시적으로 채워야 한다.
- 인스턴스 수명은 **반드시 요청 단위**여야 한다.
  - 전역 싱글턴으로 공유하면 메모리 누수 및 테넌트/사용자 간 캐시 오염 위험이 발생한다.

## Croco의 현재 기반: AsyncLocalStorage 기반 요청 컨텍스트

Croco는 `@croco/framework-context`의 `Context`가 AsyncLocalStorage로 request-scope를 제공한다.

- `Context.run(requestContext, fn)` 내부에서만 request-scope가 활성화된다.
- `Context.getCache()`는 요청 스코프 `Map<string, unknown>`(scopedCache)를 제공한다.
- DI 컨테이너의 request-scope(`Container.getRequestScoped`)도 이 캐시를 사용한다.

이 설계는 DataLoader의 “per-request cache” 요구사항과 자연스럽게 결합된다.

## 패턴 A/B 비교

### 패턴 A: GraphQL-layer DataLoader (Facebook 스타일)

#### 개요

- GraphQL 리졸버에서 `context.loaders.*.load(id)` 형태로 DataLoader를 사용한다.
- 로더 인스턴스는 요청 context에 저장하여 리졸버 간 공유한다.

#### 장점

- GraphQL N+1 문제를 빠르게 해결할 수 있다.
- 리졸버 단위 최적화가 쉬워 초기 도입 장벽이 낮다.

#### 단점

- REST 경로에는 동일한 이득이 적용되지 않는다.
- 로더가 리졸버마다 생성/주입되면서 “분산된 복잡도”가 생기기 쉽다.
- 멀티테넌트/권한 스코프가 키에 누락되면 캐시 오염(데이터 누출) 사고 위험이 커진다.
- 관측(OTel) 규약이 리졸버 구현에 종속되기 쉽다.

#### Croco 적합성

- 프로토콜 또는 transport Plugin에 최적화 로직이 들어가므로 다른 프로토콜에서 재사용하기 어렵다.

---

### 패턴 B: Data-layer 배칭 (Repository/Service 내부 배칭)

#### 개요

- Repository/Service 레이어에서 단건 호출을 내부적으로 request-scope 배치 로더에 합류시킨다.
- GraphQL/REST 어느 경로로 들어오든 동일한 효과를 얻는다.

#### 장점

- REST + GraphQL 공통 최적화 (transport-agnostic).
- 배칭/캐시 키 규약(tenant/auth 포함), 실패 모드, 관측(OTel)을 중앙에서 표준화하기 쉽다.
- 테스트(단위/통합)에서 재현이 쉬워 유지보수성이 높다.

#### 단점

- 데이터 경계(Repository/Service 계약)에서 설계를 신중히 해야 한다.
- "표현 계층 전용" 최적화(오직 GraphQL에서만 의미 있는 join)는 데이터 레이어에 넣기 어려울 수 있다.

#### Croco 적합성

- Croco의 역할별 경계 구조에서, 배칭은 Transport/Protocol이 아닌 **데이터 접근 경계(Integrations/Repository)**에 두는 것이 자연스럽다.
- 기존 AsyncLocalStorage 기반 `Context.getCache()`를 per-request cache로 재사용 가능.

---

### 비교 표

| 축              | 패턴 A (GraphQL-layer)        | 패턴 B (Data-layer)         |
| --------------- | ----------------------------- | --------------------------- |
| 성능 효과 범위  | GraphQL 중심                  | REST + GraphQL 공통         |
| 복잡도 위치     | 리졸버에 분산                 | 데이터 경계에 집중          |
| 유지보수        | 리졸버 변경에 민감            | 도메인/리포지토리 계약 중심 |
| 테스트 용이성   | GraphQL 통합 위주             | 단위/통합 모두 수월         |
| 멀티테넌트 안전 | 로더 다수일수록 위험면적 증가 | 키 규약 중앙화로 안전       |
| 관측(OTel)      | 리졸버 구현 종속              | 표준화 가능                 |

## 최종 권고(Oracle 상담 기반)

### 결론

- Croco의 “프레임워크 표준”으로는 **패턴 B(데이터 레이어 배칭)** 를 기본 권장한다.
- 패턴 A는 GraphQL에서만 필요한 경우에 **선택적 최적화(얇은 래퍼)** 로 허용하되,
  리졸버가 별도 로더를 남발하지 않도록 “공식 경로”를 제공한다.

### 이유

- REST/GraphQL 모두에서 N+1이 발생하므로, 데이터 레이어에서 해결해야 공통효과를 얻는다.
- AsyncLocalStorage 기반 `Context` + `scopedCache`가 이미 request-scope 캐시의 기반이다.
- 멀티테넌트/권한 키 규칙, 부분 실패, 캐시 무효화 등 위험한 결정을 한 곳에서 표준화할 수 있다.

## AsyncLocalStorage 통합 설계 (per-request cache)

### 저장 위치

- `Context.getCache(): Map<string, unknown> | undefined`를 “요청 스코프 로더 레지스트리”로 사용한다.

### 이름 규약(키)

요청 캐시에 저장할 로더의 키는 충돌을 피하기 위해 명시적으로 네임스페이스한다.

- 예: `dataloader:Team.byId:v1` 같은 문자열

### 멀티테넌트/권한 안전

로더 자체는 요청 단위이므로 기본적으로 요청 간 혼입은 없다.
다만 같은 요청에서도 “서로 다른 데이터 스코프”가 섞일 수 있으므로, 다음 규칙을 권장한다.

- 로더 생성 시 “스코프”를 결정한다.
  - 최소: tenantId
  - 필요 시: userId / roles / authScope 등
- 로더 이름(또는 내부 cacheKey)에는 스코프가 포함되어야 한다.
  - 예: `dataloader:Team.byId:v1:tenant={tenantId}`

> 참고: Croco `Context.get()`는 `tenantId`, `user` 등을 제공한다.

## 옵트인 API 설계

Croco는 “모든 데이터 접근을 강제”하지 않는다. 다음 2가지 옵션 중 1번을 기본으로 추천한다.

### 옵션 1) `createBatchLoader()` 팩토리 (권장)

**대상**: Repository/Service

개념:

- `createBatchLoader({ name, batchFn, maxBatchSize?, cache? ... })`
- `Context.getCache()`에 `name`으로 저장/재사용하는 헬퍼를 함께 제공한다.

장점:

- 명시적이며 데코레이터 의존이 없다.
- 테스트/관측(OTel) 규약을 표준화하기 쉽다.

### 옵션 2) `@Batch()` 데코레이터 (보조)

**대상**: Service 메서드

개념:

- 메서드를 “배칭 가능한 단건 API”로 선언하면, 호출이 request-scope 배치로 합류된다.

주의:

- 디버깅 및 실패 모드가 숨겨질 수 있으므로, 프레임워크 기본 경로로는 factory를 우선한다.

## 실패 모드/정책(설계 시 확정해야 하는 것)

### 부분 실패(Per-key error)

- 배치 호출에서 일부 키만 실패할 수 있다.
- DataLoader 스타일에서는 결과 배열의 해당 인덱스에 `Error`를 두어 개별 reject를 유도한다.

Croco 적용 시 고려:

- "not found"와 같은 도메인 에러는 `@croco/problems-core`(Problem 하위 클래스)로 표준화하는 방향이 자연스럽다.
- 캐시에 에러를 저장할지(에러 캐싱)는 매우 신중히 결정해야 한다.
  - 기본 권장: 에러 캐싱은 꺼두거나(또는 not-found만 짧게), 정책을 명시한다.

### 캐시 무효화

요청 내에서 write 후 read가 발생하면 stale cache가 생길 수 있다.
정책 선택지:

- write 후 `prime()`(혹은 해당 키 invalidate)로 동기화
- write 경로는 캐시를 우회

## 관측(Observability) 설계 (OpenTelemetry)

권장 규약:

- 배치 플러시 1회 = span 1개
  - 예: `repo.Team.batchLoad`
- span attribute:
  - `croco.batch.size` (키 개수)
  - `croco.batch.partial_errors` (부분 실패 개수)
  - `croco.batch.cache_hit` / `cache_miss`

추가로, `pnpm-lock.yaml`에 `@opentelemetry/instrumentation-dataloader`가 이미 존재하므로(의존성 상태에 따라),
도입 시 자동 계측 옵션도 검토할 수 있다. (단, 본 설계는 의존성 추가/강제를 전제로 하지 않는다.)

## Croco 역할별 경계 아키텍처와의 정렬

- Kernel (`framework-context`): 요청 스코프 저장소(ALS) 제공 → 로더의 수명/캐시를 안전하게 관리
- Contracts (`protocols-rest`)와 protocol Plugin (`protocols-graphql`): 계약/데코레이터 제공 → 로더 사용을 강제하지 않음
- Transport Plugins (`transports-graphql`, `transports-http`): 요청 진입점에서 `Context.run()` 실행 → per-request 로더 활성화
- Application 데이터 접근(앱 코드의 Repository/Service): 실제 배칭 로직 배치 → transport에 독립적인 성능 개선

## 구현 가이드(블루프린트)

### 최소 도입 순서

1. framework-context에 request-scope 로더 저장 규약을 정의한다(기존 `Context.getCache()` 활용).
2. 1~2개 대표 Repository에서 `byIds` 배치 로더를 사용하도록 한다.
3. GraphQL은 리졸버에서 데이터 레이어 API를 그대로 호출(추가 로더 생성 최소화)한다.

### 도입 체크리스트

- [ ] 로더가 요청 단위로만 생성/재사용되는가?
- [ ] batch 결과가 입력 keys의 순서/길이를 보장하는가?
- [ ] 테넌트/권한 스코프가 키/로더 네임에 반영되는가?
- [ ] 부분 실패가 예측 가능한 방식으로 전파되는가?
- [ ] span/metric으로 배치 플러시가 관측 가능한가?
