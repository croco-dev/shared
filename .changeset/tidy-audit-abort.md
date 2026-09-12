---
"@croco/audit-core": patch
---

Stop pending backoff timers and subsequent audit write retries when the fire-and-forget handle is aborted. In-flight operations retain their successful result; cancellation does not report retry exhaustion.
