---
editUrl: false
next: false
prev: false
title: "DrizzleMeterRepository"
---

미터 정의와 사용량 기록을 Drizzle로 저장하는 저장소입니다.

## Extends

- [`MeterRepository`](/api/metering-core/src/classes/meterrepository/)

## Constructors

### Constructor

> **new DrizzleMeterRepository**(`db`, `txManager`, `config`, `logger?`): `DrizzleMeterRepository`

DB, 트랜잭션 매니저, 스키마 설정을 받아 저장소를 초기화합니다.

#### Parameters

##### db

[`DrizzleDb`](/api/metering-drizzle/src/type-aliases/drizzledb/)

##### txManager

[`TxManager`](/api/tx-core/src/classes/txmanager/)\<[`DrizzleDb`](/api/metering-drizzle/src/type-aliases/drizzledb/)\>

##### config

[`DrizzleMeterRepositoryConfig`](/api/metering-drizzle/src/type-aliases/drizzlemeterrepositoryconfig/)

##### logger?

[`ILogger`](/api/framework-context/src/interfaces/ilogger/)

#### Returns

`DrizzleMeterRepository`

#### Overrides

[`MeterRepository`](/api/metering-core/src/classes/meterrepository/).[`constructor`](/api/metering-core/src/classes/meterrepository/#constructor)

## Properties

### replayContract

> `readonly` **replayContract**: `"idempotent"`

saveUsageRecords must persist each (tenantId, meterId, idempotencyKey) at most once,
including concurrent calls, overlapping batches, partial failures and process restarts.
Enforce uniqueness in persistent storage; an in-process cache is insufficient.

#### Overrides

[`MeterRepository`](/api/metering-core/src/classes/meterrepository/).[`replayContract`](/api/metering-core/src/classes/meterrepository/#replaycontract)

## Methods

### findAll()

> **findAll**(): `Promise`\<[`MeterDefinition`](/api/metering-core/src/type-aliases/meterdefinition/)[]\>

모든 미터 정의를 조회합니다.

#### Returns

`Promise`\<[`MeterDefinition`](/api/metering-core/src/type-aliases/meterdefinition/)[]\>

#### Overrides

[`MeterRepository`](/api/metering-core/src/classes/meterrepository/).[`findAll`](/api/metering-core/src/classes/meterrepository/#findall)

---

### findByMeterIdAndTenant()

> **findByMeterIdAndTenant**(`meterId`, `tenantId`): `Promise`\<[`MeterDefinition`](/api/metering-core/src/type-aliases/meterdefinition/) \| `null`\>

미터 ID와 테넌트 ID로 미터 정의를 조회합니다.

#### Parameters

##### meterId

`string`

##### tenantId

`string`

#### Returns

`Promise`\<[`MeterDefinition`](/api/metering-core/src/type-aliases/meterdefinition/) \| `null`\>

#### Overrides

[`MeterRepository`](/api/metering-core/src/classes/meterrepository/).[`findByMeterIdAndTenant`](/api/metering-core/src/classes/meterrepository/#findbymeteridandtenant)

---

### findByTenant()

> **findByTenant**(`tenantId`): `Promise`\<[`MeterDefinition`](/api/metering-core/src/type-aliases/meterdefinition/)[]\>

특정 테넌트의 미터 정의를 조회합니다.

#### Parameters

##### tenantId

`string`

#### Returns

`Promise`\<[`MeterDefinition`](/api/metering-core/src/type-aliases/meterdefinition/)[]\>

#### Overrides

[`MeterRepository`](/api/metering-core/src/classes/meterrepository/).[`findByTenant`](/api/metering-core/src/classes/meterrepository/#findbytenant)

---

### save()

> **save**(`meter`): `Promise`\<[`MeterDefinition`](/api/metering-core/src/type-aliases/meterdefinition/)\>

미터 정의를 저장하고 저장된 결과를 반환합니다.

#### Parameters

##### meter

[`MeterRegistrationOptions`](/api/metering-core/src/type-aliases/meterregistrationoptions/)

#### Returns

`Promise`\<[`MeterDefinition`](/api/metering-core/src/type-aliases/meterdefinition/)\>

#### Overrides

[`MeterRepository`](/api/metering-core/src/classes/meterrepository/).[`save`](/api/metering-core/src/classes/meterrepository/#save)

---

### saveUsageRecords()

> **saveUsageRecords**(`records`): `Promise`\<`void`\>

사용량 기록을 배치로 저장합니다.

#### Parameters

##### records

[`UsageRecord`](/api/metering-core/src/type-aliases/usagerecord/)[]

#### Returns

`Promise`\<`void`\>

#### Overrides

[`MeterRepository`](/api/metering-core/src/classes/meterrepository/).[`saveUsageRecords`](/api/metering-core/src/classes/meterrepository/#saveusagerecords)
