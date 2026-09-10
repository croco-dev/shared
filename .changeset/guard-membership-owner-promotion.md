---
"@croco/membership-core": patch
"@croco/membership-drizzle": patch
---

Reject non-owner promotion to owner through role updates with RoleHierarchyViolationProblem at the atomic command boundary. Use ownership transfer for existing members; ordinary role changes, owner no-ops, command replay, and last-owner protection remain supported.
