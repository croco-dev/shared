---
"@croco/tx-core": patch
"@croco/tx-drizzle": patch
---

Check savepoint support against the active transaction client so unsupported Drizzle clients join the parent transaction. Allow savepoints to be explicitly disabled for drivers whose nested transaction method is unsupported.
