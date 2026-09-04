---
"@kenkaiiii/ggcoder": patch
---

Fix a Windows race in the cross-process compaction lock. When one session released the lock while another was acquiring it, Windows reported the mid-delete lock directory as `EPERM` rather than `EEXIST`, and the acquiring side threw instead of waiting. `EPERM`/`EBUSY`/`EACCES` on the lock `mkdir` are now treated as contention and retried on the normal poll, so simultaneous compactions coordinate cleanly on Windows too.
