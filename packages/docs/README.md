# @croco/docs

Croco Framework 공식 문서 사이트입니다. Starlight(Astro 기반)로 구축되었습니다.

## 명령어

모든 명령어는 프로젝트 루트(`../../`)에서 실행합니다:

| Command           | Action                                 |
| :---------------- | :------------------------------------- |
| `pnpm docs:dev`   | 로컬 개발 서버 시작 (`localhost:4321`) |
| `pnpm docs:build` | 프로덕션 사이트 빌드 (`./dist/`)       |

또는 docs 패키지 내에서 직접 실행:

| Command        | Action              |
| :------------- | :------------------ |
| `pnpm dev`     | 로컬 개발 서버 시작 |
| `pnpm build`   | 프로덕션 빌드       |
| `pnpm preview` | 빌드 미리보기       |

## 문서 구조

문서 파일은 `src/content/docs/en/`에 위치합니다:

- `index.mdx` — 문서 랜딩 페이지
- `guides/` — 사용 가이드 (Getting Started, Architecture, etc.)

## 가이드 링크

- [Getting Started](src/content/docs/en/guides/getting-started.mdx) — Croco 설치 및 첫 API
- [Architecture](src/content/docs/en/guides/architecture.mdx) — Host, Transport, Build Target와 패키지 경계
- [Reliability Path RFC](src/content/docs/en/guides/reliability-path-rfc.mdx) — SaaS 운영 신뢰성 경로
- [Failure Semantics](src/content/docs/en/guides/failure-semantics.mdx) — Problem/retry/timeout/idempotency 실패 계약
- [Deployment Recipes](src/content/docs/en/guides/deployment-recipes.mdx) — Lambda, Workers, Node 배포 레시피
- [Events Core](src/content/docs/en/guides/events-core.mdx) — 도메인 이벤트
- [Retry Core](src/content/docs/en/guides/retry-core.mdx) — 재시도 정책

## 기여

문서 개선 제안이나 버그 보고는 GitHub Issues에서 해주세요.
