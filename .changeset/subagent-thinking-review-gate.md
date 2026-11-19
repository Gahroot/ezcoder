---
"@prestyj/cli": patch
---

Subagents now run at the parent's thinking level instead of the lowest one. The `/commit` review gate only counts a CLEAR when the reviewer read the whole diff. Questions get a full answer before the `ask_user` card instead of just the card.
