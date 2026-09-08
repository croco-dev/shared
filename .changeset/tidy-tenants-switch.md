---
"@croco/entitlements-core": patch
"@croco/transports-http": patch
---

EntitlementGuard evaluates the framework Context or request tenant when principal and user tenant claims are absent. Conflicting tenant sources still fail before entitlement evaluation. Applications must validate tenant selection and organization membership before injecting these values; the guard checks tenant entitlements, not membership.

HTTP pipelines reject conflicting request and HTTP context tenants before invoking guards, including AccessGuard-only routes. Request access remains available to exception filters; matching tenants and existing HTTP tenant injection remain supported.
