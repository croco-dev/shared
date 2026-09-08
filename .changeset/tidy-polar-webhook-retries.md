---
"@croco/billing-polar": patch
---

Throw `WebhookProcessingProblem` for internal webhook failures so HTTP handlers return 5xx and Polar can retry delivery. Preserve processing causes, rollback diagnostics, and durable subscription event intents across retries. Callers that inspected `success: false` must now catch the rejected promise.
