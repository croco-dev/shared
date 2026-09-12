---
editUrl: false
next: false
prev: false
title: "QStashTaskRunner"
---

QStash에 태스크 메시지를 발행하는 태스크 러너입니다.

## Implements

- [`TaskDispatcher`](/api/tasks-core/src/interfaces/taskdispatcher/)

## Constructors

### Constructor

> **new QStashTaskRunner**(`options`): `QStashTaskRunner`

#### Parameters

##### options

[`QStashTaskRunnerOptions`](/api/tasks-qstash/src/type-aliases/qstashtaskrunneroptions/)

#### Returns

`QStashTaskRunner`

## Methods

### execute()

> **execute**(`task`, `payload`, `options?`): `Promise`\<[`TaskDispatchResult`](/api/tasks-core/src/type-aliases/taskdispatchresult/)\>

태스크 식별자 또는 참조와 페이로드를 QStash에 발행합니다.

#### Parameters

##### task

`string` \| [`TaskReference`](/api/tasks-core/src/type-aliases/taskreference/)

##### payload

`unknown`

##### options?

[`TaskDispatchOptions`](/api/tasks-core/src/type-aliases/taskdispatchoptions/)

#### Returns

`Promise`\<[`TaskDispatchResult`](/api/tasks-core/src/type-aliases/taskdispatchresult/)\>

#### Implementation of

[`TaskDispatcher`](/api/tasks-core/src/interfaces/taskdispatcher/).[`execute`](/api/tasks-core/src/interfaces/taskdispatcher/#execute)
