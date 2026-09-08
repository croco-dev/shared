# @croco/tx-drizzle

Drizzle ORM용 `@croco/tx-core` 트랜잭션 어댑터입니다. Drizzle의 `db.transaction`/`tx.transaction(savepoint)`을 `tx-core`에 연결합니다.

## 설치

```bash
pnpm add @croco/framework-module @croco/tx-drizzle @croco/tx-core drizzle-orm typedi
```

## 사용법

### Application plugin

`drizzleTransaction`은 애플리케이션의 격리된 모듈 컨테이너에 `TxManager`를 등록하고 Drizzle 상태 확인을
`diagnostics.provider` contribution으로 제공합니다. 이 경로는 전역 `TxManagerRegistry`를 사용하지 않습니다.

```ts
import { createApplicationRuntime, defineCrocoApplication } from "@croco/framework-module";
import { TxManager } from "@croco/tx-core";
import { drizzleTransaction } from "@croco/tx-drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

const application = defineCrocoApplication({
  imports: [
    drizzleTransaction({
      db,
      transaction: { defaultNesting: "join" },
      diagnostics: { name: "primary-database" },
      shutdown: () => pool.end(),
    }),
  ],
});
const runtime = createApplicationRuntime(application);

await runtime.initialize();
const txManager = runtime.get(TxManager);
const diagnostics = runtime.getContributions("diagnostics.provider");
await runtime.dispose();
```

기존 `TxManagerRegistry`와 `Container.set` 경로는 호환성을 위해 유지되지만 새 애플리케이션 구성에는 plugin
factory를 사용하세요. plugin factory의 `db`, transaction 설정, diagnostics 이름은 명시적 입력이며 ambient
package discovery를 사용하지 않습니다. 애플리케이션이 데이터베이스 리소스를 소유하면 `shutdown`으로 정리
함수를 등록하고 `ApplicationRuntime.dispose()`가 완료될 때까지 기다리세요.

### 1. Drizzle DB 생성 및 어댑터 연결

```ts
import "reflect-metadata";
import { Container } from "typedi";
import { TxManager } from "@croco/tx-core";
import { createDrizzleTxAdapter } from "@croco/tx-drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

const adapter = createDrizzleTxAdapter(db);
const txManager = new TxManager(adapter, { defaultNesting: "join" });

Container.set(TxManager, txManager);
```

### 2. TxManager 등록

```ts
import 'reflect-metadata';
import { Container } from 'typedi';
import { TxManager } from '@croco/tx-core';
import { createDrizzleTxAdapter } from '@croco/tx-drizzle';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

const adapter = createDrizzleTxAdapter(db);
const txManager = new TxManager(adapter, { defaultNesting: 'join' });

Container.set(TxManager, txManager);
      const adapter = createDrizzleTxAdapter(db);
      const txManager = new TxManager(adapter, { defaultNesting: 'join' });
      Container.set(TxManager, txManager);
    },
  ],
});
```

### 3. 서비스에서 @Transactional 사용

```ts
import { Service } from "typedi";
import { Transactional, TxManager } from "@croco/tx-core";

@Service()
class UserService {
  constructor(private readonly txManager: TxManager<typeof db>) {}

  @Transactional()
  async createUser(name: string) {
    const client = this.txManager.getClient()!;
    await client.insert(users).values({ name });
  }

  @Transactional({ nesting: "savepoint" })
  async updateUserWithSavepoint(id: string, name: string) {
    const client = this.txManager.getClient()!;
    await client.update(users).set({ name }).where(eq(users.id, id));
  }
}
```

## API

### createDrizzleTxAdapter(db, adapterOptions?)

Drizzle DB 인스턴스를 받아 `TxAdapter`를 반환합니다.

```ts
import { createDrizzleTxAdapter } from "@croco/tx-drizzle";

const adapter = createDrizzleTxAdapter(db);
```

반환된 어댑터는 다음을 지원합니다:

- `transaction(fn, options?)`: `db.transaction` 호출
- `savepoint(client, fn, options?)`: `tx.transaction` 호출 (중첩 트랜잭션). 세이브포인트가 비활성화되어 있거나 클라이언트에 `transaction()`이 없으면 `SavepointUnsupportedProblem`으로 즉시 실패
- `supportsSavepoint(client?)`: 활성 트랜잭션 클라이언트의 `transaction()` 메서드를 확인. `adapterOptions.supportsSavepoint: false`이면 항상 `false` 반환. 클라이언트를 생략하면 기존처럼 기본값 `true` 반환

`TxManager`는 중첩 실행 전에 현재 클라이언트로 지원 여부를 확인합니다. 지원하지 않으면 경고를 남기고 부모 트랜잭션에 참여합니다. 이 경우 중첩 구간만 독립적으로 롤백할 수 없으며, 상위로 전파된 오류는 부모 트랜잭션을 롤백합니다.

드라이버가 `transaction()` 메서드를 제공하더라도 중첩 실행을 지원하지 않는다면 명시적으로 비활성화하세요.

```ts
const adapter = createDrizzleTxAdapter(db, { supportsSavepoint: false });
```

`supportsSavepoint: true`도 클라이언트에 없는 메서드를 지원하게 만들지는 않습니다. 이 설정은 세이브포인트에만 적용되며, 드라이버의 루트 트랜잭션 지원이 필요합니다.

### 타입 유틸리티

```ts
import { InferTxClient, InferTxOptions } from "@croco/tx-drizzle";

type TxClient = InferTxClient<typeof db>;
type TxOptions = InferTxOptions<typeof db>;
```

### PostgreSQL RLS

`createRlsPolicy`와 `createRlsTxAdapter`는 동일한 PostgreSQL 설정 키 규칙을 사용하며, 잘못된 설정은 SQL 또는 트랜잭션이 실행되기 전에 `RlsConfigurationProblem`으로 거부합니다. Problem에는 잘못된 필드 이름만 포함되고 설정 값은 포함되지 않습니다.

- 테이블 이름: `table` 또는 `schema.table`
- 테넌트 컬럼과 관리자 역할: 단일 식별자
- 테넌트 컬럼 타입: `tenantColumnType: "uuid" | "text"`. 기본값은 기존 동작과 같은 `"uuid"`입니다. `text` 컬럼에 문자열·슬러그 ID를 저장한다면 `"text"`를 지정하여 UUID 캐스팅을 생략합니다. 기존 정책은 이 옵션만 변경해도 갱신되지 않으므로 마이그레이션에서 정책을 다시 생성해야 합니다.
- 설정 키: 정확히 `namespace.parameter` 두 부분
- 각 식별자 부분: `[A-Za-z_][A-Za-z0-9_$]*`, 최대 63 UTF-8 바이트
- 미리 따옴표 처리된 이름은 허용하지 않습니다. 논리 이름을 전달하면 헬퍼가 PostgreSQL 식별자 인용을 적용합니다.
- 정책 이름은 테이블의 마지막 부분에 `_tenant_isolation`을 붙여 생성하며, 생성된 이름도 63바이트 제한을 지켜야 합니다.

```ts
const policySql = createRlsPolicy({
  tableName: "Tenant.Order",
  tenantColumn: "tenant_id",
  configKey: "app.current_tenant",
  adminRoles: ["app_admin", "support_admin"],
});

const adapter = createRlsTxAdapter(db, tenantProvider, {
  configKey: "app.current_tenant",
});
```

런타임 어댑터는 `set_config(name, value, true)`를 파라미터화하여 현재 트랜잭션 범위에만 테넌트 값을 설정합니다.

`debug: true`는 RLS 설정 직전에 진단 로그를 기록합니다. `logger`를 직접 주입할 수 있으며, 생략하면 프레임워크 컨테이너에서 `Logger`를 해석합니다. 디버그가 요청된 상태에서 로거를 해석할 수 없거나 로그 기록이 실패하면 `RlsDebugLoggingProblem`으로 명시적으로 실패합니다. `debug`가 꺼져 있으면 로거가 없어도 트랜잭션 동작은 바뀌지 않습니다.

```ts
const adapter = createRlsTxAdapter(db, tenantProvider, {
  debug: true,
  logger,
});
```

## Dialect 지원

이 패키지는 dialect-agnostic으로 설계되어 Drizzle이 지원하는 모든 데이터베이스에서 동작합니다:

- PostgreSQL
- MySQL
- SQLite

각 dialect의 트랜잭션 옵션은 Drizzle의 타입 시그니처에서 자동으로 추론됩니다.

## Peer Dependencies

- `drizzle-orm` >=0.30.0
