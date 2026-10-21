---
"@kenkaiiii/gg-core": patch
---

Stop a rejected OAuth token refresh from signing every window out: re-read auth.json before deleting the credential, and adopt a newer login that another gg process saved while the refresh was in flight.
