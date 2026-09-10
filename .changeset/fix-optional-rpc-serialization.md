---
"@croco/rpc-codegen": patch
---

Generated RPC clients serialize omitted or null query and header inputs without throwing, preserving configured default headers.
