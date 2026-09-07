---
"@croco/auth-better-auth": patch
---

Accept signed webhook timestamps with up to nine fractional-second digits, including microseconds and nanoseconds. Event age checks retain JavaScript Date's millisecond precision, and invalid dates and timezone offsets remain rejected.
