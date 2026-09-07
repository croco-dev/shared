---
"@croco/auth-better-auth": patch
---

Restrict authorization claims to the admin plugin's top-level role by default. Require explicit trusted user fields and metadata keys for other claims, and warn without logging claim values when untrusted claims are ignored. Applications using implicit metadata mapping must verify server-only writes before opting in.
