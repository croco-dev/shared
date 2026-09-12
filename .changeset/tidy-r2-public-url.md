---
"@croco/storage-r2": patch
---

Require an explicit publicUrlBase when generating R2 public URLs. Missing configuration now throws MissingR2ConfigProblem instead of returning a fabricated r2.dev hostname. Private object operations and signed URLs remain available without a public URL base.
