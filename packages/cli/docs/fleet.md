# Fleet: use your other machines

EZCODER can send work to the other computers you own: builds, browser tests,
video renders, deploys, local AI models on a GPU box, remote browsers and dev
environments. Adding a machine never requires changing a project, and nothing
blocks a session: every command returns at once and you're notified when work
finishes.

- **Node**: any machine running `ezcoder node serve` (Linux, Windows WSL2, macOS).
- **Controller**: EZCODER on your main machine. It keeps the node list, picks
  where work runs, remembers jobs across restarts and notifies sessions.

Nodes are reached over [Tailscale](https://tailscale.com) (a private network; no
open ports), or over TLS with a pinned certificate. Each node has its own token.

| Page                                                 | For                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| [fleet-quickstart.md](fleet-quickstart.md)           | Add a Linux, WSL2 or macOS machine in five minutes                 |
| [fleet-nodes.md](fleet-nodes.md)                     | Node setup in detail: Docker, GPUs, run at login, secrets, updates |
| [fleet-agents.md](fleet-agents.md)                   | Helper agents on other machines                                    |
| [fleet-goals.md](fleet-goals.md)                     | Goal workers and verifiers on nodes                                |
| [fleet-troubleshooting.md](fleet-troubleshooting.md) | Every error message, its cause and fix                             |
| [fleet-security.md](fleet-security.md)               | Threat model, and each security claim with its test                |
| [fleet-data.md](fleet-data.md)                       | What leaves your machine and where it goes                         |

## What can run where

| Work                           | Needs on the node                                     |
| ------------------------------ | ----------------------------------------------------- |
| `build`, `test`, `custom` jobs | git access to the repo; Docker for jobs with `docker` |
| `browser` jobs (Playwright)    | Docker (Playwright image)                             |
| `render` jobs                  | Docker; CPUs/memory as declared                       |
| `deploy` jobs                  | the `deploy` label and node-local secrets             |
| `llm` inference service        | a GPU (`gpu` label is automatic) and Docker           |
| `browser` service              | Docker                                                |
| `dev` environment              | Docker                                                |

The scheduler only uses a node that fits: labels, GPU count and GPU memory,
CPUs and memory, Docker. Among those with room right now (free slots incl.
jobs already sent there, free memory, free GPU memory) it prefers the node that
last ran the project (warm caches), then the emptiest, then the least loaded.
If nothing has room the job stays queued; if nothing could ever fit it fails at
once and says why.

## Capacity

Each node has a number of **slots**, and they are the only limit on it. One pool
of slots is shared by every kind of work sent there: fleet jobs, validation
stages, helper agents and Goal workers. Services don't take slots.

- The default is `max(1, min(cpus / 2, memoryGb / 2))`, so a 16-core 32 GB box
  gets 8.
- Change it on the node with `ezcoder node config --slots N` (any N of 1 or
  more, also above the default). A running node picks it up at once, with no
  restart. `ezcoder node doctor` warns when slots exceed the CPU count.
- Paired nodes join [validation](async-validation.md) automatically as the
  `fleet` pool; `"fleetNodes": false` in the validation backends file turns that
  off. Validation counts the node's other work, so the two never over-book it.
- When every slot is busy the node answers "busy" with a `Retry-After` time.
  The main machine keeps the work queued and starts it as soon as a slot frees;
  nothing fails because a node is full.
- No hidden cap applies on top of the slots. Six jobs, stages or agents run at
  once on one 6-slot node, or spread over six 1-slot nodes, and a seventh waits.
  To cap jobs in flight across all nodes, set `maxConcurrent` in
  `~/.ezcoder/fleet/settings.json`.

Jobs that fit a cloud sandbox (Linux, up to 4 CPUs / 16 GB, no secrets, GPU or
artifacts) overflow to Claude Code cloud when no node has room. See
[cloud.md](cloud.md).

## Pairing

The [quick start](fleet-quickstart.md) has the full steps. In short, on the
new machine run the bootstrap script for its platform (or `ezcoder node init`
and `ezcoder node install`), then:

```sh
ezcoder node doctor --repo https://github.com/you/repo   # one fix per problem
ezcoder node pair --code                                 # short code + QR
```

On your main machine:

```sh
ezcoder fleet discover                    # nodes on the tailnet, paired or not
ezcoder fleet add --code K7QM-2XPA        # or `ezcoder fleet add` and paste the string at the prompt
ezcoder fleet nodes                       # online, slots, CPU/memory, GPUs, labels
ezcoder fleet rotate-token gpu-box        # new token; the old one stops working at once
ezcoder fleet update gpu-box              # bring the node's EZ Coder up to date
ezcoder fleet remove gpu-box
```

`fleet add` refuses a node it can't reach or whose token is rejected, unless
you pass `--offline`, and shows the node's doctor report. Controller and node
check each other's protocol version on every request; a mismatch says which
side to update.

Paired nodes live in `~/.ezcoder/fleet/nodes.json` (mode 0600, it holds tokens).

## Jobs

```sh
ezcoder fleet run build                 # the pushed HEAD, best fitting node
ezcoder fleet run e2e --node my-pc      # pin a node
ezcoder fleet run build --uncommitted   # include local changes as a patch
ezcoder fleet status                    # config and recent jobs
ezcoder fleet logs <id>                 # agents use the fleet tool's tail / offset / grep instead of the whole log
ezcoder fleet artifacts <id> [--out dir]
ezcoder fleet cancel <id>
```

A job runs an exact commit: the node clones `origin` at that SHA with its own
git credentials. If the commit isn't on `origin` the job is refused ("push
first"), unless you pass `--uncommitted`. Then the newest pushed commit plus a
patch of your local commits, edits and new files is sent (max 50 MB).

Artifacts (globs in the job config) are downloaded to
`<project>/.ezcoder/artifacts/<jobId>/` when the job ends, or to `--out`.

Agents use the `fleet` tool (`run`, `status`, `logs`, `artifacts`, `cancel`,
`nodes`, `service_up`, `service_down`, `services`, `exec`). Results arrive as
notifications.

### Project config (optional)

Without a config, EZCODER detects:

- `build`: from `package.json`, Cargo, Go or a Makefile.
- `e2e`: when a Playwright config exists.
- `dev`: from `.devcontainer/devcontainer.json`, a Dockerfile, or a language image.

`browser` and `llm` services are always available. Add or override any of
these in `.ezcoder/fleet.json`:

```json
{
  "jobs": {
    "render": {
      "kind": "render",
      "command": "npm ci && node scripts/render.mjs",
      "docker": { "dockerfile": "engine/Dockerfile" },
      "resources": { "cpus": 8, "memoryGb": 8 },
      "artifacts": ["out/**/*.mp4"],
      "timeoutMinutes": 120
    },
    "deploy": {
      "kind": "deploy",
      "command": "./scripts/deploy.sh",
      "secrets": ["DEPLOY_TOKEN"],
      "resources": { "labels": ["deploy"] }
    }
  },
  "services": {
    "api": {
      "kind": "devenv",
      "docker": { "image": "node:22" },
      "ports": [{ "container": 3000, "name": "http" }]
    }
  }
}
```

Job kinds: `build`, `test`, `validate`, `browser`, `render`, `deploy`, `custom`.
Jobs that use a compose file only run on nodes labelled `compose`.
Resources: `cpus`, `memoryGb`, `gpus`, `gpuMemoryGb`, `labels`.

## Services

```sh
ezcoder fleet service up llm            # Ollama on a GPU node
ezcoder fleet service up browser        # remote Playwright server
ezcoder fleet service list
ezcoder fleet service log llm
ezcoder fleet service down llm
```

- **Inference**: the service's OpenAI-compatible endpoint is added as a local
  model endpoint labelled `fleet:<node>/<service>`, so the model picker lists
  its models. It's removed when the service stops.
- **Browser**: the `browser` tool keeps launching a local Chromium by default.
  It connects to a remote Playwright server instead when one of these is set:
  - `EZCODER_BROWSER_WS=ws://…`
  - `EZCODER_FLEET_BROWSER=<service id or node/name>`
  - `"browser"` in `~/.ezcoder/fleet/settings.json`
  - the agent called `fleet service_up browser` with `use: true`

  The remote Playwright version must match this one; the built-in service uses
  the same version automatically.

### Dev environments

```sh
ezcoder fleet dev up                    # your current work (uncommitted included) in a container
ezcoder fleet dev exec npm test
ezcoder fleet dev down
```

## Gates

`deploy` jobs only run when the project's required validation stages passed
for the exact commit (`ezcoder validate gate`). This is checked when you queue
the deploy and again right before dispatch. Deploys always run pushed commits,
never patches. A project can turn the gate off for one job with `"gate": false`.

Secrets are never sent from your machine. They live on the node
(`ezcoder node secret set NAME`); only `deploy` jobs can name them, and only nodes
labelled `deploy` accept those jobs.

## Recovery

Controller state is in `~/.ezcoder/fleet/` (`jobs.json`, `services.json`). It
survives restarts, and exactly one EZCODER process (a session or
`ezcoder fleet daemon`, started for you) polls nodes.

- A node that stays unreachable for 3 minutes while running a job, or reports
  the job `lost`, gets that job requeued on another fitting node, up to 3
  attempts. This applies to `build`, `test`, `validate`, `browser`, `render`
  and `custom`.
- **Deploys are never retried automatically** (they may have partly run). They
  end in `error` and you're told to check the target. If a node doesn't answer
  when a deploy is sent, the deploy waits for that node to confirm whether it
  started; it is never sent to a second node.
- A state file that can't be read is set aside as `<name>.corrupt-<time>`
  instead of being overwritten.

Settings (`~/.ezcoder/fleet/settings.json`): `maxConcurrent` (jobs in flight
across all nodes; unset means only the nodes' slots limit it) and `browser`.

## Model credentials

Remote agents on a node use the node's own login (`ezcoder login` there). To
copy this machine's credentials instead, opt in explicitly:

```sh
ezcoder fleet share-auth gpu-box --yes
```

It refuses to replace credentials the node already has unless you add `--force`.

## Costs

Nodes are your own hardware: no per-minute charges. The costs are their
electricity and the model usage of agents running on them. GitHub Actions
validation workers (see `async-validation.md`) keep working alongside nodes.
