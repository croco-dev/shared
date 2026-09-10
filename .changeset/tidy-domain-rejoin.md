---
"@croco/invitation-core": patch
"@croco/invitation-drizzle": patch
---

Revalidate completed domain auto-join memberships and allow removed users to rejoin under the current enabled policy. Renew intent generations atomically and retain command identity across partial failures. Custom DomainPolicyStore adapters must implement renewAutoJoinIntent with the documented compare-and-swap contract and enforce the required expectedEventId argument on membership completion, event claims, and uncommitted cleanup.
