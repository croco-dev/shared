---
editUrl: false
next: false
prev: false
title: "MeterRepository"
---

Meter 정의 및 Usage 데이터를 DB에 저장하는 추상 클래스

## Description

구현체는 사용자가 제공 (예: Drizzle, Prisma 등)
metering-core는 이 추상 클래스만 의존

## Extended by

- [`DrizzleMeterRepository`](/api/metering-drizzle/src/classes/drizzlemeterrepository/)

## Constructors

### Constructor

> **new MeterRepository**(): `MeterRepository`

#### Returns

`MeterRepository`

## Properties

### replayContract

> `abstract` `readonly` **replayContract**: `"idempotent"`

saveUsageRecords must persist each (tenantId, meterId, idempotencyKey) at most once,
including concurrent calls, overlapping batches, partial failures and process restarts.
Enforce uniqueness in persistent storage; an in-process cache is insufficient.

## Methods

### findAll()

> `abstract` **findAll**(): `Promise`\<[`MeterDefinition`](/api/metering-core/src/type-aliases/meterdefinition/)[]\>

앱 시작 시 모든 meter 로딩

#### Returns

`Promise`\<[`MeterDefinition`](/api/metering-core/src/type-aliases/meterdefinition/)[]\>

---

### findByMeterIdAndTenant()

> `abstract` **findByMeterIdAndTenant**(`meterId`, `tenantId`): `Promise`\<[`MeterDefinition`](/api/metering-core/src/type-aliases/meterdefinition/) \| `null`\>

Meter 정의 조회 (tenantId + meterId로 검색)

#### Parameters

##### meterId

`string`

##### tenantId

`string`

#### Returns

`Promise`\<[`MeterDefinition`](/api/metering-core/src/type-aliases/meterdefinition/) \| `null`\>

---

### findByTenant()

> `abstract` **findByTenant**(`tenantId`): `Promise`\<[`MeterDefinition`](/api/metering-core/src/type-aliases/meterdefinition/)[]\>

테넌트별 meter 조회

#### Parameters

##### tenantId

`string`

#### Returns

`Promise`\<[`MeterDefinition`](/api/metering-core/src/type-aliases/meterdefinition/)[]\>

---

### save()

> `abstract` **save**(`meter`): `Promise`\<[`MeterDefinition`](/api/metering-core/src/type-aliases/meterdefinition/)\>

Meter 정의 등록 (정적 + 동적 모두 사용)

#### Parameters

##### meter

[`MeterRegistrationOptions`](/api/metering-core/src/type-aliases/meterregistrationoptions/)

#### Returns

`Promise`\<[`MeterDefinition`](/api/metering-core/src/type-aliases/meterdefinition/)\>

---

### saveUsageRecords()

> `abstract` **saveUsageRecords**(`records`): `Promise`\<`void`\>

배치 저장용 - Usage 레코드들을 DB에 영구 저장

#### Parameters

##### records

[`UsageRecord`](/api/metering-core/src/type-aliases/usagerecord/)[]

#### Returns

`Promise`\<`void`\>
