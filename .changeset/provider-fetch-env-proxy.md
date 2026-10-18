---
"@kenkaiiii/gg-ai": patch
---

Provider requests honour HTTP_PROXY / HTTPS_PROXY / NO_PROXY again when Node's env proxy is on (`NODE_USE_ENV_PROXY=1` or `--use-env-proxy`). Since the 300s timeout fix, provider calls went through their own connection pool and skipped the proxy, so they failed on networks that only allow proxied traffic.
