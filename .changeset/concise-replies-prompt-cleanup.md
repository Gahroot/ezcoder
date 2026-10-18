---
"@kenkaiiii/ggcoder": patch
---

Shorter replies and a cleaner system prompt. After changing code, the agent's summary now aims for under ~100 words: a bold headline, then a few flat bullets with what changed, the check result, and any caveat or change made beyond the request. Answers and reviews keep the length they need. Progress messages between steps are one sentence. On Claude Haiku 5.5 this cut task time about 15% and cost about 15%, with no change in pass rate or test reporting. The prompt also drops a few contradictions. Language style packs no longer override a project's own conventions or push it to install a schema library. The agent runs one check after its edits instead of deferring checks to /commit. Detailed hardening rules now live only in the bulletproof skill.
