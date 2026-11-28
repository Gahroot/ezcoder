# Running agents on other machines (Fleet)

A helper agent started with `spawn_agent` can run on one of your other machines
instead of this one. The agent works in its own copy of the project there, and
its edits come back to your local folder as a patch.

## Setup

1. Set up the other machine (say `gpu-box`) as a node: see the
   [quick start](fleet-quickstart.md).
2. Give that machine model credentials, in one of two ways:
   - **Recommended:** run `ezcoder login` on `gpu-box`. The node uses its own
     `~/.ezcoder/auth.json`.
   - **Opt-in:** `ezcoder fleet share-auth gpu-box --yes` copies this machine's
     credentials over the private network. This never happens automatically,
     and it won't replace credentials the node already has unless you add `--force`.
     Subscription logins refresh themselves, so if the node refreshes first your
     main machine can be signed out; prefer `ezcoder login` on the node.
3. On your main machine, pair it: `ezcoder fleet add --code <code>`, or
   `ezcoder fleet add` and paste the pairing string. Paired nodes are
   listed in `~/.ezcoder/fleet/nodes.json`.

The node also needs git access to your repository (its own `gh auth login` or
SSH key), because it clones the code itself.

## Using it

`spawn_agent` takes an optional `machine` per task:

```json
{ "tasks": [{ "task_name": "port-tests", "task": "…", "machine": "auto" }] }
```

- `"auto"` picks a paired machine that has model credentials and a free slot,
  choosing the least loaded one.
- `"gpu-box"` uses exactly that machine. If it can't run an agent at all
  (unreachable, no credentials, docker-only, an incompatible version), the spawn
  fails with the reason.
- When every usable machine is only busy, the agent waits in a queue and starts
  as soon as a slot frees (for up to 6 hours). Agents share the node's slots
  with jobs, validation stages and Goal workers, and they don't count against
  the local agent limit.
- Leave `machine` out to run locally. Nothing changes for local agents.

`list_agents`, `wait_agent` and the spawn result show `machine` for remote
agents. Follow-ups, messages and interrupts work the same as for local agents.

## What the other machine gets

- The commit you are on (`HEAD`), fetched from your `origin` remote. **It must
  already be pushed.** If it isn't, the spawn stops and asks you to
  `git push`, or to run locally.
- Your uncommitted changes, including new untracked files, sent as a binary
  patch (max 50 MB). Your own git index is never touched while building it.
- No secrets and no credentials from this machine. The agent's environment on
  the node is an allow-list (`PATH`, `HOME`, `USER`, `LANG`, `LC_*`, `TERM`,
  `TMPDIR`, `SHELL` and a few more), not a copy of the node's environment.
  Requested variables that look like keys or tokens are dropped.

## How edits come back

After every finished turn, and when the agent closes, EZCODER asks the node for
the workspace's changes and applies only what changed since the last sync to
your local folder with `git apply --binary`. Each change lands once, even
across many turns. The turn's receipt names the files that came back, e.g.
`Edits from gpu-box applied locally: src/a.ts, test/a.test.ts`.

Files git ignores (build output, `.env`, `node_modules`) are not part of the
patch. If the agent changed any of them, the receipt lists them as not brought
back, so you know to re-create them locally.

## Conflicts

The apply is all-or-nothing. If you (or another agent) changed the same lines
locally in the meantime, **nothing is applied and your files are left exactly
as they were**: no partial edits, no conflict markers. The receipt says so,
and the patch is kept under
`~/.ezcoder/subagent-sessions/remote/<agent>/conflict-<time>.patch` along with
the command to apply it yourself:

```bash
git -C /path/to/project apply --3way --binary ~/.ezcoder/subagent-sessions/remote/<agent>/conflict-….patch
```

`--3way` leaves conflict markers for you to resolve. Later turns keep
syncing only their own new changes.

If the last sync can't finish when an agent closes (the node stopped answering,
or the patch could not be applied), nothing is thrown away: either the whole
patch is saved next to the conflict patches as `unsynced-<time>.patch`, or the
agent's folder is left on the node, and the message says which.

## Restarts and dropped connections

- A brief network drop is retried for up to 3 minutes. The agent keeps
  running on the node meanwhile, and its output is buffered.
- The node keeps a disconnected agent for 10 minutes. If EZCODER restarts
  within that window, a follow-up to the agent re-attaches to the same remote
  agent instead of starting a new one locally.
- If the node itself restarts, it re-adopts the agent's workspace. The worker
  process is gone (marked `error`), but its edits stay on the node and can still
  be fetched.
- Closing the agent stops it on the node and removes its workspace.

## Limits

- The project must be a git repository with an `origin` remote.
- Nodes started as docker-only don't run helper agents.
- Goal workers take a `machine` too; see [fleet-goals.md](fleet-goals.md).
