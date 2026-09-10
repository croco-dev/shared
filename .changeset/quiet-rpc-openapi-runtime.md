---
"@croco/rpc-codegen": patch
"@croco/protocol-codegen": patch
"@croco/openapi-spec": patch
---

Initialize each application's Zod OpenAPI runtime before evaluating RPC controller schemas, sharing the existing CommonJS and ESM initialization with OpenAPI generation.
