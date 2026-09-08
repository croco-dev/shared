---
"@croco/entitlements-core": patch
---

EntitlementGuard evaluates the framework Context or request tenant when principal and user tenant claims are absent. Conflicting tenant sources still fail before entitlement evaluation. Applications must validate tenant selection and organization membership before injecting these values; the guard checks tenant entitlements, not membership.
