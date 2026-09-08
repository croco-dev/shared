---
"@croco/billing-core": patch
---

Repeated order saves now update the existing order within its billing account instead of duplicating paid-order history. Custom billing stores must upsert by billing account and order ID to support webhook retries.
