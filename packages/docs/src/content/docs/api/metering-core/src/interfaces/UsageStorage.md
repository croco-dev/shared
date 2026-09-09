---
editUrl: false
next: false
prev: false
title: "UsageStorage"
---

Redis 기반 실시간 Usage 저장소 인터페이스

## Description

구현체: RedisUsageStorage (이 패키지 내) 또는 사용자 커스텀
모든 메서드는 tenant 격리를 보장해야 함

## Properties

### replayContract

> `readonly` **replayContract**: `"idempotent"`

MeteringService가 lease 만료 후 persistence를 안전하게 재개할 수 있음을 선언합니다.

## Methods

### checkAndRecordWithinQuota()

> **checkAndRecordWithinQuota**(`options`): `Promise`\<[`AtomicQuotaCheckResult`](/api/metering-core/src/type-aliases/atomicquotacheckresult/)\>

동일한 tenantId, meterId, usageRecord.idempotencyKey 조합의 재시도는 사용량을 중복 기록하지 않고
최초 호출과 동일한 quota 결과를 반환해야 합니다.

#### Parameters

##### options

[`AtomicQuotaCheckOptions`](/api/metering-core/src/type-aliases/atomicquotacheckoptions/)

#### Returns

`Promise`\<[`AtomicQuotaCheckResult`](/api/metering-core/src/type-aliases/atomicquotacheckresult/)\>

---

### deleteUsageRecords()?

> `optional` **deleteUsageRecords**(`options`, `records`): `Promise`\<`void`\>

Usage 데이터 삭제 (배치 저장 후)
UsageAggregator requires this method and rejects unsupported storage at construction.
Delete only the supplied records; repeated deletion must be safe.
저장이 성공한 경우에만 호출되어야 함

#### Parameters

##### options

[`UsageQueryOptions`](/api/metering-core/src/type-aliases/usagequeryoptions/)

##### records

[`UsageRecord`](/api/metering-core/src/type-aliases/usagerecord/)[]

#### Returns

`Promise`\<`void`\>

---

### fetchUsageRecords()

> **fetchUsageRecords**(`options`): `Promise`\<[`UsageRecord`](/api/metering-core/src/type-aliases/usagerecord/)[]\>

Usage 데이터 조회 (배치 저장용)
Redis에서 특정 기간의 usage records 조회

#### Parameters

##### options

[`UsageQueryOptions`](/api/metering-core/src/type-aliases/usagequeryoptions/)

#### Returns

`Promise`\<[`UsageRecord`](/api/metering-core/src/type-aliases/usagerecord/)[]\>

---

### getUsage()

> **getUsage**(`options`): `Promise`\<`number`\>

Usage 조회 (특정 기간 합산)

#### Parameters

##### options

[`UsageQueryOptions`](/api/metering-core/src/type-aliases/usagequeryoptions/)

#### Returns

`Promise`\<`number`\>

---

### isIdempotent()

> **isIdempotent**(`tenantId`, `meterId`, `idempotencyKey`, `ttlSeconds`): `Promise`\<`boolean`\>

Idempotency 체크 (SET NX 기반)

#### Parameters

##### tenantId

`string`

##### meterId

`string`

##### idempotencyKey

`string`

##### ttlSeconds

`number`

#### Returns

`Promise`\<`boolean`\>

true: 새 키 (기록 가능), false: 중복 (기록 불가)

---

### record()

> **record**(`usage`): `Promise`\<`void`\>

Usage 기록 (즉시 flush)
Redis Sorted Set에 저장

동일한 tenantId, meterId, idempotencyKey 조합의 재시도는 사용량을 중복 기록하지 않아야 합니다.

#### Parameters

##### usage

[`UsageRecord`](/api/metering-core/src/type-aliases/usagerecord/)

#### Returns

`Promise`\<`void`\>

---

### resetBillingCycle()?

> `optional` **resetBillingCycle**(`tenantId`, `meterId?`): `Promise`\<`void`\>

빌링 주기 리셋
현재 빌링 주기의 모든 usage 데이터를 삭제합니다.

#### Parameters

##### tenantId

`string`

테넌트 ID

##### meterId?

`string`

Meter ID (optional, 없으면 해당 테넌트의 모든 meter 리셋)

#### Returns

`Promise`\<`void`\>
