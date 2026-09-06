---
"@croco/transports-http": patch
---

Preserve API Gateway v2 session and authentication cookies when a Cookie header is also present. Merge both sources by case-sensitive cookie name, preserving the explicit header value on conflicts and the first occurrence within each source. Preserve cookie values without decoding them.
