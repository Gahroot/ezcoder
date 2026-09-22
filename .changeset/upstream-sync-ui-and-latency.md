---
"@prestyj/ai": minor
"@prestyj/core": minor
"@prestyj/agent": minor
"@prestyj/cli": minor
"@prestyj/boss": minor
---

Add UI library tooling, cut slow agent turns, and refresh the model lineup.

- New `ui_registry` and `ui_adopt` tools, plus bundled UI-library guidance in the `evidence-led-ui` skill, so UI work starts from a real component library instead of hand-rolled markup. Adoption writes stay on the local filesystem and go through the same write guard (including goal mode) as every other mutation.
- Slow-turn fixes: compaction triggers are latency-capped, and the stream's first-event watchdog now scales with prompt size (45s base, 180s ceiling) instead of a fixed budget. A large uncached prompt can legitimately take 44-68s to prefill, and the old fixed 45s timeout turned those turns into false stalls plus a full cold re-prefill. Per-turn prompt-cache health is now observable from normalized provider usage.
- Model lineup: adds Grok 4.7 and the full-modal MiMo-V2.6 series (image and video input across Pro, Flash, and Pro-UltraSpeed), and retires the superseded Grok 4.6/4.5 and MiMo-V2.5 ids. Saved sessions on a retired id fall back to the provider default on next start.
- Temporary-file access now resolves correctly across macOS, Linux, and Windows, and ACP forwards tool images in both live updates and replayed history.
