---
"@croco/events-core": patch
---

Keep inherited event field metadata isolated so sibling event classes can reuse serialized field names without corrupting
their parent.
