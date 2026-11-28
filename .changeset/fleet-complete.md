---
"@prestyj/cli": minor
---

Fleet, finished: every machine you own is one pool of capacity.

- **Full capacity, any mix.** Each node's slots are shared by all work (fleet jobs, validation stages, helper agents, Goal workers). Paired nodes join validation automatically, nothing is capped below real capacity, and busy work queues instead of failing. Run six tests on one node, one on each of six nodes, or any combination. Set slots live with `ezcoder node config --slots N`.
- **Setup:** `ezcoder node doctor`, pairing by short code or QR (`node pair --code`, `fleet add --code`), `fleet add` reads the pairing string from a prompt, protocol/version handshake that names the side to update, `node rotate-token`, `node uninstall [--purge]`, `node update` / `fleet update <node>`, bootstrap scripts for Linux/WSL2 and macOS, optional TLS with certificate pinning.
- **Reliability:** remote agents survive node restarts, nodes clean up old jobs, logs and caches, per-job log cap, safe artifact downloads, custom jobs retry only with `"retry": true`, controller cleans up leftovers, git submodules, ignored files listed as not brought back.
- **Security:** `node serve --docker-only`, allow-listed environment for agents and jobs, credentials stripped from git URLs, deploy secrets in the OS keychain, Docker mounts limited to the job's own folders, `share-auth` won't overwrite without `--force`.
- **Agents:** `fleet` tool runs ad hoc commands (and N shards at once), tails/greps logs, explains which nodes are usable (`doctor`), shows queue position, proposes a project `fleet.json`, and failure notices include the failing lines.
- **Goals on the fleet:** Goal workers and the verifier can run on nodes (`machine`, `verifier_machine`, `max_remote_workers`), conflicting edits are never applied silently, and a whole Goal can run on a node (`ezcoder goals host`) and push its result branch.
- **Desktop app:** Machines panel with capacity, Add a machine flow with doctor results, fleet jobs in the activity area with logs, machine badges on helpers and Goal workers, remove / new key / share login from the panel.

Existing nodes must be updated: on each node run `npm i -g @prestyj/cli@latest` and restart `ezcoder node serve`.
