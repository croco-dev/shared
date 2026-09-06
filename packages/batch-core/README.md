# @croco/batch-core

대용량 데이터 처리를 위한 배치 프레임워크입니다. Spring Batch의 개념(Reader, Processor, Writer)을 차용하여 Node.js 환경에 맞게 구현했습니다.

## 특징

- **Chunk 지향 처리**: 메모리 효율적인 대용량 데이터 처리
- **단계별 구성 (Step & Job)**: 재사용 가능한 스텝과 작업 구성
- **체크포인트 & 재시작**: 실패 지점부터 재시작 가능한 구조 (Checkpointable)
- **실패 분류**: 영구 실패와 일시 실패를 구분하여 실행 상태에 전달
- **타입 안전성**: 제네릭을 통한 입출력 타입 보장

## 설치

```bash
pnpm add @croco/batch-core
```

## 주요 개념

- **ItemReader**: 데이터를 읽어오는 역할 (예: DB 조회, 파일 읽기)
- **ItemProcessor**: 데이터를 가공하는 역할 (비즈니스 로직)
- **ItemWriter**: 가공된 데이터를 저장하는 역할 (예: DB 저장, 파일 쓰기)
- **Step**: Reader -> Processor -> Writer 로 구성된 단위 작업
- **Job**: 하나 이상의 Step으로 구성된 전체 배치 작업

## 사용 방법

### 1. Reader, Processor, Writer 구현

```typescript
import type { ItemReader, ItemProcessor, ItemWriter } from "@croco/batch-core";

// Reader
class UserReader implements ItemReader<User> {
  private offset = 0;
  async read(): Promise<User | null> {
    const users = await db.users.find({ skip: this.offset, take: 1 });
    this.offset++;
    return users[0] || null;
  }
}

// Processor
class UserActiveProcessor implements ItemProcessor<User, UserActiveEvent> {
  async process(user: User): Promise<UserActiveEvent | null> {
    if (!user.isActive) return null; // 필터링
    return { userId: user.id, timestamp: new Date() };
  }
}

// Writer
class EventWriter implements ItemWriter<UserActiveEvent> {
  async write(events: UserActiveEvent[]): Promise<void> {
    await eventBus.publishAll(events);
  }
}
```

### 2. Job 구성

`JobBuilder`를 사용하여 Step과 Job을 구성합니다.

```typescript
import { JobBuilder, Step } from "@croco/batch-core";

const userStep = new Step({
  name: "process-active-users",
  reader: new UserReader(),
  processor: new UserActiveProcessor(),
  writer: new EventWriter(),
  chunkSize: 100,
});

const job = new JobBuilder("daily-user-batch").start(userStep).build();
```

Step 이름은 비어 있거나 공백만으로 구성될 수 없으며, 하나의 Job 안에서 checkpoint identity로
유일해야 합니다. `JobBuilder.build()`는 중복 이름을 실행 또는 persistence side effect 전에 거부합니다.

### 3. 실패 재시도 분류

기본적으로 Step 실행 중 발생한 오류는 재시도 가능한 실패로 기록됩니다. 검증 오류처럼 재시도해도 해결되지 않는 실패는 `classifyFailure`로 분류할 수 있습니다.

```typescript
class ValidationError extends Error {
  code = "VALIDATION_ERROR";
}

const importStep = new Step({
  name: "import-users",
  reader: new UserReader(),
  processor: new UserProcessor(),
  writer: new UserWriter(),
  classifyFailure(error) {
    if (error instanceof ValidationError) {
      return { retryable: false, code: error.code };
    }

    return true;
  },
});
```

### 4. 멀티 스텝 체크포인트 경계

`ChunkExecutor`는 기본적으로 단일 스텝 배치 작업을 실행한다고 보고 스텝이 끝나면 실행을
`completed`로 전이합니다. 여러 스텝이 하나의 실행을 공유한다면 중간 스텝에서 실행을 완료하지
않도록 `completeExecution: false`를 전달하고, 이후 스텝은 이미 `running` 상태인 실행을 재사용하도록
`startExecution: false`를 전달합니다. 체크포인트는 `step.name.cursor` 키로 저장되므로 각 스텝의
재시작 지점은 분리됩니다.

```typescript
await chunkExecutor.execute(executionId, extractStep, { completeExecution: false });
await chunkExecutor.execute(executionId, loadStep, { startExecution: false });
```

## 운영 경계와 복구 절차

`ChunkExecutor`는 `@croco/execution-core`의 실행 상태를 사용해 체크포인트, 진행률, 실패 메타데이터를
남깁니다. 운영자는 실패한 실행을 조회해 `status`, `error`, `progress`, `checkpoints`를 확인한 뒤 같은
실행 ID로 다시 실행할 수 있습니다.

- `chunkSize`는 성공적으로 처리한 입력 수를 기준으로 하며, processor가 `null`을 반환한 항목도 포함합니다.
  각 청크와 마지막 남은 입력의 처리가 끝나면 `step.name.cursor` 체크포인트를 갱신합니다. 출력이 있는
  청크는 writer가 완료된 뒤에만 갱신하고, 모두 필터링된 청크는 writer 호출 없이 갱신합니다.
- `progress.current`와 완료 결과의 `processedCount`도 필터링된 입력을 포함합니다. 진행률 갱신은 유효한
  `progress.total`이 설정된 실행에만 적용됩니다.
- 재시도 가능한 실패는 `execution-core`가 실행을 `retrying` 상태로 남기며, 다음 `execute()` 호출은 마지막
  체크포인트를 reader에 복원합니다.
- 재시도 중 진행률은 기존 `progress.current`에서 이어집니다. 체크포인트 이후 남은 청크만 처리해도 완료
  결과의 `processedCount`는 전체 실행 기준으로 유지됩니다.
- writer가 실패한 청크는 체크포인트를 갱신하지 않습니다. 같은 청크가 재전달될 수 있으므로 writer는
  실행 ID, 스텝 이름, 입력 키, 또는 애플리케이션 idempotency key로 중복 쓰기를 흡수해야 합니다.
- `classifyFailure`가 실패하면 원래 오류 메시지는 유지하되 `batch-core/failure-classification-failed` 코드로
  실행 실패 메타데이터에 남깁니다. 분류기 오류가 실제 처리 실패를 성공처럼 숨기지 않습니다.

운영 재시도 예:

```typescript
const execution = await manager.create({
  type: "batch",
  maxAttempts: 2,
  idempotencyKey: "import-users:2026-06-29",
});

try {
  await chunkExecutor.execute(execution.id, importStep);
} catch {
  const current = await manager.get(execution.id);
  if (current.status === "retrying") {
    await chunkExecutor.execute(execution.id, importStep);
  }
}
```

## 검증 명령

```bash
pnpm --filter @croco/batch-core test
pnpm --filter @croco/batch-core typecheck
pnpm docs:catalog:check
pnpm public-api:check
```
