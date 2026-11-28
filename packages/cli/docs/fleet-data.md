# Fleet: what leaves your machine, and where it goes

Fleet sends data only between your main machine and nodes you paired yourself,
over Tailscale (encrypted, peer to peer) or TLS. Nothing goes to an EZ Coder
server; there isn't one. The tables below list everything that crosses.

## From the main machine to a node

| What                                                                        | When                                                         | Notes                                                                                                                            |
| --------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| The node's token                                                            | Every request                                                | Sent as a bearer header. Stored on the main machine in `~/.ezcoder/fleet/nodes.json` (mode 0600).                                |
| Protocol and CLI version                                                    | Every request                                                | `x-ezcoder-protocol` and `x-ezcoder-version` headers.                                                                            |
| Your `origin` URL, without credentials                                      | Jobs, services, agents, Goal workers                         | `https://user:token@host/…` is sent as `https://host/…`. The node fetches the code itself with its own git credentials.          |
| The commit SHA and sub-folder                                               | Same                                                         | Only the commit; your branch names and other refs stay local.                                                                    |
| A patch of uncommitted work                                                 | `--uncommitted`, `fleet dev up`, helper agents, Goal workers | A binary `git diff` of tracked and new untracked files against the pushed commit, max 50 MB. Git-ignored files are not included. |
| The project name and cache key                                              | Jobs and services                                            | Used to keep caches apart on the node.                                                                                           |
| The job's command, env, Docker settings, artifact globs, resources, timeout | Jobs                                                         | From `.ezcoder/fleet.json` or what the agent asked for. Secret **names** only; never values.                                     |
| Messages to a helper agent                                                  | Remote agents, Goal workers                                  | Its task and follow-ups, over a WebSocket. Your main machine's folder paths are replaced by the node's workspace path.           |
| Model credentials                                                           | Only when you run `ezcoder fleet share-auth <node> --yes`    | Copied into the node's `~/.ezcoder/auth.json`. Never automatic; existing ones are kept unless you add `--force`.                 |
| A Goal's verifier command                                                   | `verifier_machine` set                                       | Runs as a fleet job at the exact commit.                                                                                         |

Your main machine's environment variables, home folder, other projects,
sessions, settings and git credentials are never sent.

## From a node back to the main machine

| What                              | Notes                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hello (no token needed)           | Node name, EZ Coder version, protocol, platform, features, and the TLS fingerprint when serving https. Anyone on the tailnet can ask for this.                     |
| Node info                         | Hostname, CPU, memory, disk, load, GPUs, Docker, labels, slots, whether it has a model login, and its jobs, services and agents.                                   |
| Job state, logs and artifacts     | Logs only as much as asked for (a tail, a byte range, or matching lines). Artifacts go to `<project>/.ezcoder/artifacts/<jobId>/` or `--out`.                      |
| A helper agent's output and edits | Its replies, plus a binary patch of its edits after each turn, applied to your folder. Git-ignored files it changed are named in the receipt but not brought back. |
| Doctor report                     | The checks and fixes from `ezcoder node doctor`. The repo URL it reports has credentials stripped.                                                                 |
| Workspace paths on the node       | For example `~/.ezcoder/node/agents/<id>/repo`, shown in status.                                                                                                   |

## What stays on the node

- `~/.ezcoder/node/node.json`: name, token, port, bind address, labels, slots,
  TLS file paths (mode 0600).
- `~/.ezcoder/node/state.json`: jobs, services and agents, so they survive a
  restart.
- `jobs/`, `run/`, `artifacts/`, `agents/`, `services/`, `cache/`: workspaces,
  logs and caches. Finished work older than 7 days and caches beyond 20 GB are
  removed while the node runs (`ezcoder node config --gc-days N --cache-cap-gb N`).
- Deploy secrets: values in the OS keychain, names in `secret-names.json`.
  They never leave the node except into a deploy job's environment there.
- The node's own model login (`~/.ezcoder/auth.json`) and git credentials.

Remote agents and Goal workers on a node use that node's model login, so their
model requests go from the node straight to your model provider, as they would
on your main machine.

## Hostnames

The pairing string holds the node's name, its tailnet hostname (for example
`gpu-box.your-tailnet.ts.net`) or IP, the port and the token. `fleet discover`
reads your tailnet's peer list with `tailscale status` and asks each peer for
`/v1/hello`; it doesn't contact anything outside the tailnet.

## Removing it all

- On the main machine: `ezcoder fleet remove <node>` forgets a node and its token.
- On the node: `ezcoder node uninstall` removes the run-at-login service, and
  `ezcoder node uninstall --purge` also deletes `~/.ezcoder/node` (workspaces,
  logs, caches, state, token) and the node's deploy secrets from the keychain.
  It says what it removed.
