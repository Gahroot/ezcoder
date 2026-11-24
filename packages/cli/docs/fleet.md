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
open ports). Each node has its own token.

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

## Pairing

On the new machine:

```sh
npm i -g @prestyj/cli
ezcoder node init        # prints a pairing string
ezcoder node serve
```

On your main machine:

```sh
ezcoder fleet discover                                  # nodes on the tailnet, paired or not
ezcoder fleet add 'ezfleet://gpu-box@gpu-box.tailnet.ts.net:7377#<token>'
ezcoder fleet nodes                                     # online, slots, CPU/memory, GPUs, labels
ezcoder fleet remove gpu-box
```

Paired nodes live in `~/.ezcoder/fleet/nodes.json` (mode 0600, it holds tokens).

## Jobs

```sh
ezcoder fleet run build                 # the pushed HEAD, best fitting node
ezcoder fleet run e2e --node my-pc      # pin a node
ezcoder fleet run build --uncommitted   # include local changes as a patch
ezcoder fleet status                    # config and recent jobs
ezcoder fleet logs <id>
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
(`ezcoder node secret set NAME`); jobs only name them, and only nodes labelled
`deploy` accept jobs with secrets.

## Recovery

Controller state is in `~/.ezcoder/fleet/` (`jobs.json`, `services.json`). It
survives restarts, and exactly one EZCODER process (a session or
`ezcoder fleet daemon`, started for you) polls nodes.

- A node that stays unreachable for 3 minutes while running a job, or reports
  the job `lost`, gets that job requeued on another fitting node, up to 3
  attempts. This applies to `build`, `test`, `validate`, `browser`, `render`
  and `custom`.
- **Deploys are never retried automatically** (they may have partly run). They
  end in `error` and you're told to check the target.

Settings (`~/.ezcoder/fleet/settings.json`): `maxConcurrent` (jobs in flight
across all nodes, default 8) and `browser`.

## Model credentials

Remote agents on a node use the node's own login (`ezcoder login` there). To
copy this machine's credentials instead, opt in explicitly:

```sh
ezcoder fleet share-auth gpu-box --yes
```

## Costs

Nodes are your own hardware: no per-minute charges. The costs are their
electricity and the model usage of agents running on them. GitHub Actions
validation workers (see `async-validation.md`) keep working alongside nodes.
