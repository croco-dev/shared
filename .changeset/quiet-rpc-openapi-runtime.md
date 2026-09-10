---
"@croco/rpc-codegen": patch
"@croco/protocol-codegen": patch
"@croco/openapi-spec": patch
"@croco/problems-core": patch
---

Initialize each application's Zod OpenAPI runtime before evaluating RPC controller schemas, sharing the existing CommonJS and ESM initialization with OpenAPI generation.

Keep generated Problem source locations aligned with the controller loaders.
