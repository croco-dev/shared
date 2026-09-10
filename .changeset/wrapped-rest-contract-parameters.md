---
"@croco/problems-core": patch
"@croco/protocols-core": patch
"@croco/protocols-rest": patch
"@croco/rpc-codegen": patch
"@croco/transports-http": patch
---

Bind parameters from refined, transformed, and piped object route contracts without decorator evaluation failures. Wrapped contracts validate once per request and inject their parsed output, preserving handler types and cross-field validation.

RPC generation reports unsupported transformed path schemas with the JSON-safety diagnostic before checking path field bindings.
