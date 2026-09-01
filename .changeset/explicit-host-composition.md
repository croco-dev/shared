---
"@croco/cli": patch
"@croco/framework-context": minor
"@croco/framework-module": minor
"@croco/framework-preset": minor
"@croco/frontend-cloudflare": patch
"@croco/frontend-react": patch
"@croco/frontend-vite": patch
"@croco/preset-cloudflare": minor
"@croco/preset-lambda": minor
"@croco/preset-node": minor
"@croco/problems-core": patch
"@croco/transports-http": minor
"create-croco-app": patch
---

Expose host, transport, and build-target composition as separate runtime metadata, bind host callbacks
to their owning application scope, preserve the legacy Cloudflare handler context, and teach generated
apps and presentation adapters to use explicit host and build-target entry points. Generated Lambda and
Cloudflare SaaS apps now advertise commands that validate their actual deployment targets, including a
Wrangler configuration with explicit Node.js compatibility for the generated Worker composition.
