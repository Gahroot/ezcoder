---
"@prestyj/core": patch
"@prestyj/cli": patch
---

Fix the Opus 5.5 lockout caused by a stale spoofed Claude Code version.

Anthropic gates newly released models on a minimum Claude Code version, and we spoof that version in the `claude-cli` User-Agent. It was cached on disk for a flat 24h, so anyone whose cache predated the 2.1.280 release was refused with "Claude Code 2.1.278 does not support this model" for up to a day, with no way to force a refresh.

- The cache is now stale-while-revalidate: entries under an hour old are served instantly, older ones still answer instantly but trigger a background refresh, and anything past 24h blocks on a real fetch instead of being served blind.
- A rejection is now treated as authoritative. The required version is parsed from the error, pinned as a floor, persisted synchronously, and the turn is retried immediately on the corrected User-Agent, so the failure self-heals within one request instead of waiting out a TTL.
- Version comparison is numeric per segment. A lexical compare ranks `2.1.9` above `2.1.280`, which would have served a User-Agent the API rejects.
- The offline fallback constant moves to 2.1.280.
