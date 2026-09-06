---
"@croco/transports-http": patch
---

Lambda request bodies preserve binary bytes when Base64 contains whitespace, URL-safe characters, or omitted padding, while malformed encodings still fail validation.
