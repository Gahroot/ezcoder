---
"@kenkaiiii/ggcoder": patch
---

Turns no longer show as unverified when the agent's tests actually passed. Agents often run tests inside a longer command (`npm test 2>&1 | tail; node -e '…'`), and that command's exit status comes from its last part, so the tests never counted. When a turn would end unverified that way, GG now runs that test command once more on its own and records its real result. It never runs checks the agent skipped. If nothing was edited since, a pass counts as verification. A failed re-run leaves the turn unverified without marking it failed.
