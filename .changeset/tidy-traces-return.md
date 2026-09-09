---
"@croco/telemetry-api": patch
---

Preserve synchronous return values from @Trace methods and end their spans immediately. Promise results remain traced until settlement, and synchronous exceptions retain their identity and error recording.
