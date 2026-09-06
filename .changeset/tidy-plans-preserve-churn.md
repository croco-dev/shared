---
"@croco/billing-core": patch
"@croco/billing-polar": patch
"@croco/metrics-billing": patch
---

Cancellation events retain the pinned plan version so churn metrics can be recorded after immediate cancellation deletes the subscription. Older events without a plan version continue to use the stored subscription.
