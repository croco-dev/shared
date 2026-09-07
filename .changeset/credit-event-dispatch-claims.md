---
"@croco/credits-core": minor
"@croco/credits-drizzle": minor
---

Claim credit outbox events atomically so concurrent workers and command replays share one publication lease. Expired leases can be reclaimed, and stale workers cannot acknowledge or release replacement claims.

Custom publishers must replace `publishIdempotentlyAfterCommit(event, onPublished)` with `onAfterCommit(publish)` and schedule the supplied callback after commit. Custom stores must implement lease claims and token-fenced completion and release. Existing PostgreSQL deployments must add nullable `claim_token` text and `claim_expires_at` timestamptz columns before deploying the updated workers, and stop old workers during the rollout. Publishers must continue deduplicating by event ID when delivery outlives a lease or acknowledgement is lost.
