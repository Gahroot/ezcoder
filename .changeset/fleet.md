---
"@prestyj/cli": minor
---

EZCODER Fleet: send work to your other machines over Tailscale. `ezcoder node` turns any Linux, Windows WSL2 or macOS machine into a node; `ezcoder fleet` and the `fleet` tool run builds, Playwright, renders and gated deploys there (artifacts come back), start long-running services (GPU model servers that appear in the model list, remote browsers, dev environments), and run helper agents remotely with `spawn_agent` `machine`. Jobs are placed by free slots, CPU, memory and GPU, survive restarts and move to another node if one drops. Validation can also run on nodes (`"fleetNodes": true`).
