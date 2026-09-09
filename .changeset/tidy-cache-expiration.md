---
"@croco/cache-core": patch
---

Ignore concurrently written entries that expire before a getOrSet loader completes, and cache the loaded value with its requested TTL.
