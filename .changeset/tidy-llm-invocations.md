---
"@croco/llm-metering": patch
---

Count repeated AiMetered calls independently with unique default invocation keys and resolve tenant identity from request Context before instance defaults. Explicit tenant options and custom idempotency key extractors retain precedence.
