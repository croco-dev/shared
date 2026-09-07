---
"@croco/batch-qstash": patch
---

Deduplicate continuation publications at the QStash broker with a stable SHA-256 deduplication ID that avoids provider-reserved characters, including retries of a staged publication, while preserving the destination Idempotency-Key header.

Process an already delivered continuation after recovering a lost publication response or confirmation without republishing and acknowledging its only queued message.
