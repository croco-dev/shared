---
"@croco/rpc-codegen": patch
---

Generated Result methods return an external failure when response body reading is aborted in either problem runtime, preserving the original cancellation error.
