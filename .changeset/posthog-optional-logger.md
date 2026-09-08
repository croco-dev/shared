---
"@croco/analytics-posthog": patch
---

Use console logging when LOGGER_TOKEN is not registered so provider failures remain contained, disabled operations can complete, and flush failures retain their typed Problem.
