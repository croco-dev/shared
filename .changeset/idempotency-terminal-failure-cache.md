---
"@croco/idempotency-core": patch
---

Cache non-retryable handler failures so duplicate requests return the stored failure without repeating execution. Respect explicit retryability and client-error status, and allow a per-request retry policy while preserving audit and commit recovery.
