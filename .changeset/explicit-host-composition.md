---
"@croco/cli": patch
"@croco/framework-context": minor
"@croco/framework-module": minor
"@croco/framework-preset": minor
"@croco/preset-cloudflare": minor
"@croco/preset-lambda": minor
"@croco/preset-node": minor
"@croco/problems-core": patch
"@croco/transports-http": minor
"create-croco-app": patch
---

Expose host, transport, and build-target composition as separate runtime metadata, bind host callbacks
to their owning application scope, and teach generated apps and build preset compatibility facades to
use explicit host and build-target entry points.
