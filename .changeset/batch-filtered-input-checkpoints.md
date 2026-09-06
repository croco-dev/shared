---
"@croco/batch-core": patch
---

Checkpoint batch steps after each chunk of successfully processed input, including filtered items, so retries resume beyond committed filtered input. Progress and processedCount include filtered input; writers receive only retained items and are not called for empty output chunks.
