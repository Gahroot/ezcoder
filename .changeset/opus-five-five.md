---
"@prestyj/ai": minor
"@prestyj/core": minor
"@prestyj/cli": minor
"@prestyj/boss": minor
---

Add Claude Opus 5.5 (`claude-opus-5-5`, released 2026-09-22) and make it the default Anthropic model. 1M context, 128k output, image input, always-on adaptive thinking with the full effort ladder (low→max, xhigh included), at $4/$20 MTok — cheaper than the Opus 5 it leads.

- Fresh sessions start at `medium` effort, matching Anthropic's declared server-side default for this model (Opus 5 ran `high`, and 5.5 thinks more per turn at a given level). The `max` ceiling is unchanged, so `/thinking` still cycles all the way up.
- Forced tool use (`tool_choice` `any`/`tool`) returns a 400 on Opus 5.5 and the Fable/Mythos line, so `@prestyj/ai` now downgrades it to `auto` instead of failing the request.
- Thinking can't be disabled on this model; `@prestyj/ai` already omits the `thinking` field when thinking is off, so that path is unaffected.
- Footers short-name it "Opus" (Opus 5 becomes "Opus 5"), login/provider descriptions list it, and ezboss's default boss model moves from `claude-opus-5` to `claude-opus-5-5`. Opus 5 stays registered as a legacy option — it's the last Opus that accepts disabled thinking and forced tool use.
