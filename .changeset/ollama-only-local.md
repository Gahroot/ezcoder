---
"@kenkaiiii/gg-core": minor
"gg-app": minor
---

Simplify local models to Ollama. The Connect AI Providers tile and its modal are renamed "Ollama", the tile carries Ollama's official mark, and `DEFAULT_LOCAL_ENDPOINTS` drops the LM Studio, llama.cpp, and vLLM auto-probes — the modal showed four rows when usually only Ollama exists. Those servers still work: "Add endpoint" adds any OpenAI-compatible URL as a custom endpoint (removable, as before), and the model picker's "Local" group is unchanged. Empty-state and scan copy now points at Ollama and the new "Add from Hugging Face" download flow. Login copy is also refreshed across both UIs: provider descriptions now match the model registry (Grok 4.6, Gemini 3.7 Flash), and the dual-auth guidance and priority notes are cut to one line each.
