---
"@croco/storage-r2": patch
---

Recognize NoSuchKey and NotFound errors when HTTP status metadata is missing or does not report 404, preserving FileNotFoundProblem for reads and false for existence checks.
