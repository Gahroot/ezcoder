---
"@kenkaiiii/ggcoder": minor
"gg-app": minor
---

Add "Add from Hugging Face" to the desktop app: search the Hub and pull models with Ollama, in one modal. From Connect AI Providers, the Hugging Face tile offers "Search Hugging Face and download with Ollama" next to its hosted-token login, and the Local models modal gains an "Add from Hugging Face" button. The modal debounces typed queries into a live dropdown of GGUF repos (downloads/likes inline, full keyboard navigation), and clicking a model starts `ollama pull hf.co/<repo>:<quant>` immediately — the sidecar picks the quant from the repo's real file list (Q4_K_M preferred), streams `hf_pull` progress events into a cancellable progress bar, re-scans local endpoints on success so the model appears in the picker without a restart, and maps known failures to fixes (the Ollama 0.32 hf.co pull bug → upgrade; 401 → connect an HF token, which is also passed to pulls for gated repos). Pull state lives in the sidecar, so closing the modal mid-download never cancels it — reopening reattaches. One pull at a time; client sends only validated `org/repo` ids, and the child is spawned with argv (never a shell string).
