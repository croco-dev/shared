---
"@croco/workflow-core": patch
---

Publish compensation outbox messages automatically after a failed saga reaches its terminal state. Failed and compensated executions dispatch only compensation messages, preserving forward intent without publishing it during recovery or replay.
