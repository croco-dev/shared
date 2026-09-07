---
"@croco/invitation-core": patch
---

Report a status conflict instead of expiration when invitation acceptance loses a compare-and-set operation but the invitation is still pending and unexpired. Preserve the invitation for a later acceptance attempt and retain expiration diagnostics at the expiry boundary.
