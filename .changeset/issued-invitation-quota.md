---
"@croco/invitation-core": patch
"@croco/invitation-drizzle": patch
---

Count invitations issued within hourly and daily windows regardless of their current status, so acceptance, revocation, decline, or expiry cannot restore issuance quota. Custom InvitationStore implementations must implement countIssuedByTenant(tenantId, since) using tenant identity and an inclusive createdAt lower bound without filtering status. The existing countPendingByTenant contract is unchanged.
