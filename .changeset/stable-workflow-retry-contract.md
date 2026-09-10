---
"@croco/workflow-core": patch
---

Typed workflow retries use structural contract fingerprints that remain stable across function formatting and bundling changes. Step identity, order, resolver presence, and declared execution options still guard persisted results. Use new explicit workflow or task names for incompatible changes to payloads or results. Drain existing v1 typed retries on the previous deployment before upgrading to the v2 fingerprint format.
