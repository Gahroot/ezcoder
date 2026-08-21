---
"@kenkaiiii/gg-ai": minor
"@kenkaiiii/gg-core": minor
"@kenkaiiii/ggcoder": minor
---

Add Gemini 3.7 Flash (`gemini-3.7-flash`, released 2026-08-13) and retarget `deepseek-v4-pro` to DeepSeek-V4-Pro-0813 under the same API id. 3.7 Flash is Google's most capable Flash for coding and agents — 1M context, 64K output, thinking low/medium/high, video input (20 MB inline cap) — listed as a selectable option for Gemini but kept non-default because it ships on our Code Assist transport ahead of gemini-cli (issue #28802 tracks upstream); free/personal accounts get the existing account-gated 404 guidance while entitled Code Assist Standard/Enterprise accounts can use it. DeepSeek's `deepseek-v4-pro` alias now serves the first stable V4 Pro (0813, supersedes the April preview, calling name unchanged): max output corrected to 393,216 and costTier dropped to `medium` to match the ~$0.43/$0.87 per-MTok pricing; saved sessions keep working since the id is unchanged.
