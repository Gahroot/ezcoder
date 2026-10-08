---
"@kenkaiiii/gg-ai": patch
"@kenkaiiii/gg-agent": patch
"@kenkaiiii/gg-core": patch
"@kenkaiiii/ggcoder": patch
---

Packages now declare Node.js 22 or newer as their supported runtime, matching what CI tests. `ggcoder` no longer ships its internal benchmark scripts in the npm tarball, and `gg-core` now has a README covering the model registry, auth storage and local-model discovery.
