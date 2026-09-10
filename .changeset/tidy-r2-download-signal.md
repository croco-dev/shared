---
"@croco/storage-r2": patch
---

Buffered R2 downloads bind the operation signal once, preserving cancellation errors without redundant stream wrappers.
