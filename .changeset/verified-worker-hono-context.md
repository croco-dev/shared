---
"@croco/preset-cloudflare": patch
---

Require explicit raw mode for legacy Hono Worker callbacks and accept current Hono execution contexts without casts. Raw forwarding preserves bindings and execution context identity; Croco runtime dispatch remains the default.
