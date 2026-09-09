---
"@croco/metering-core": minor
"@croco/metering-drizzle": patch
"@croco/problems-core": patch
"create-croco-app": patch
---

Usage flush rejects storage without deletion support and requires repositories to declare durable idempotent persistence. Custom MeterRepository implementations must enforce uniqueness for tenantId, meterId and idempotencyKey before declaring replayContract as idempotent. Retries after deletion failures preserve one persisted usage record per identity.
