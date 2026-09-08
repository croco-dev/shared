---
"@croco/search-meilisearch": patch
---

Isolate shared-index document primary keys by tenant while preserving original document IDs in search results, filters, and deletion. Internal keys do not add full-text tokens under default tokenization. Existing indexes must be recreated and reindexed before writes; incompatible primary keys are rejected.
