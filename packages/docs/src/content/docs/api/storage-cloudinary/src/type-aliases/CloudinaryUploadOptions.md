---
editUrl: false
next: false
prev: false
title: "CloudinaryUploadOptions"
---

> **CloudinaryUploadOptions** = `object`

Cloudinary 업로드에 사용할 확장 옵션입니다.

## Properties

### context?

> `optional` **context?**: `Record`\<`string`, `string`\>

컨텍스트 메타데이터 (key-value 쌍)

---

### eager?

> `optional` **eager?**: `unknown`[]

업로드 시 적용할 변환 (eager transformations)

---

### folder?

> `optional` **folder?**: `string`

업로드할 폴더 경로

---

### publicId?

> `optional` **publicId?**: `string`

사용자 정의 public ID (key)

---

### resourceType?

> `optional` **resourceType?**: `"image"` \| `"video"` \| `"raw"`

리소스 타입. CloudinaryProvider는 키 확장자로 전체 객체 lifecycle의 타입을 결정합니다.

---

### tags?

> `optional` **tags?**: `string`[]

태그 목록
