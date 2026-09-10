---
"@croco/frontend-react": patch
---

Infer ISR mode when revalidateSeconds or legacy revalidate is provided without an explicit mode. Explicit modes remain authoritative, and legacy ssr defaults apply only without a revalidation interval.
