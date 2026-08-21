---
"@kenkaiiii/gg-ai": minor
"@kenkaiiii/gg-core": minor
"@kenkaiiii/ggcoder": minor
---

Add a first-class `huggingface` provider backed by Hugging Face's Inference Providers router (`https://router.huggingface.co/v1`, OpenAI-compatible Chat Completions, one HF token with "Make calls to Inference Providers" permission). Model ids are Hub repo paths: `Qwen/Qwen3-Coder-480B-A35B-Instruct` (default; 262K context, tool-native, non-thinking Coder line) and `openai/gpt-oss-120b` (low-tier sibling for summaries and scout sub-agents; reasoning effort low/medium/high). Auth is a static API key wired through the existing apikey login flow in both TUI and desktop app, with label/logo/order entries everywhere providers are enumerated (`config`/`settings-manager`/`app-sidecar`/`auth-providers`/`ModelSelector`/`login`/`provider-labels`/`provider-logos`). Local-weight users keep the existing routes: Ollama `hf.co/...` pulls and any self-hosted OpenAI-compatible server via local endpoints.
