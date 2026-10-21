---
"@kenkaiiii/gg-core": patch
---

Keep long-lived processes logging: rotate the debug log mid-run when the shared file fills, and count the 10 MB cap against this process's own writes instead of the whole file. The app daemon previously went dark within minutes when it started next to a nearly full log.
