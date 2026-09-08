---
"@croco/tx-drizzle": minor
"@croco/problems-core": patch
---

Allow RLS policies to compare text tenant identifiers with tenantColumnType: "text", while preserving the default UUID cast and rejecting unsupported column types.

Keep generated RLS Problem source locations aligned with the expanded configuration field type.
