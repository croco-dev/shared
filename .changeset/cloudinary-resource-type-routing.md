---
"@croco/storage-cloudinary": patch
"@croco/problems-core": patch
---

Route document and binary keys to Cloudinary raw resources and video/audio keys to video resources, preserving their namespace across uploads, upload intents, URLs, reads, metadata, and deletion.

Keep generated Problem registry source references aligned with the Cloudinary upload validation contract.
