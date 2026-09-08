---
"@croco/entitlements-core": patch
"@croco/transports-http": patch
---

EntitlementGuard evaluates the framework Context or request tenant when principal and user tenant claims are absent. Conflicting tenant sources still fail before entitlement evaluation. Applications must validate tenant selection and organization membership before injecting these values; the guard checks tenant entitlements, not membership.

HTTP execution contexts preserve an existing request tenant so guards can detect conflicts with the HTTP context tenant. HTTP tenant injection remains available when the request has no tenant.
