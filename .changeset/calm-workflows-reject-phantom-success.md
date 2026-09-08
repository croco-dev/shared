---
"@croco/workflow-core": patch
"@croco/problems-core": patch
---

Only reuse completed workflow executions. Reject concurrent pending or running executions with a conflict Problem, preserve stored failures when a failed or timed-out execution is requested again, and reject other states that cannot be reused. Keep retryable workflow resumption unchanged.
