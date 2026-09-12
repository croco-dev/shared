---
"@croco/access-core": patch
"@croco/problems-core": patch
---

Reject invalid revoke tuples before provider calls and return 401 for unauthenticated access checks. AccessGuard uses the current request Context user when the request has no user.

Include `access-core/unauthorized` in the generated Problem code registry.
