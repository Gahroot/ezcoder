---
"@prestyj/cli": minor
---

Validation worker pools: register any number of machines (native Linux, Windows WSL2, or GitHub-hosted cloud runners) by runner labels, with no project changes. Jobs are placed by free slots, CPU and memory, preferring the machine with a warm cache; interrupted jobs are requeued on another machine; image-mode stages reuse a per-project dependency cache. `ezcoder validate workers` shows every machine's load.
