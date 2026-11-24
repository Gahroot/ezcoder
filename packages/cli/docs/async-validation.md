# Asynchronous validation

EZCODER runs tests without holding an agent session. A session (or a shell)
queues validation stages for an exact Git commit and carries on; an orchestrator
sends them to workers, tracks them, collects logs, posts GitHub commit statuses
and pushes the result back into the session as a notification.

Code: `packages/cli/src/core/validation/` (orchestrator, backends, config),
`packages/cli/src/tools/validate.ts` (agent tool, on-demand tier),
`packages/cli/src/cli/validate.ts` (`ezcoder validate …`).

## How it fits together

```
session / shell ──enqueue──▶ ~/.ezcoder/validation/jobs.json  (durable, file-locked)
                                     ▲            │
         notifications ◀── watch ────┘            ▼
                                   leader (a session host or `ezcoder validate daemon`)
                                     │ bounded dispatch, poll, statuses
                     ┌───────────────┴────────────────┐
                 local backend                 GitHub Actions backend(s)
          (detached shell on this Mac)   (workflow_dispatch on a worker repo:
                                          a self-hosted PC, a cloud runner,
                                          …)
```

- **Execution, logs and run history are GitHub Actions.** EZCODER only
  dispatches (`gh workflow run`), polls (`gh run view`), reads logs and posts
  statuses. No custom CI.
- **One leader** per machine (lease in `leader.json`) dispatches and polls; every
  process watches the store and notifies its own sessions. `ezcoder validate run`
  starts a background daemon only when no EZCODER process is leading; it exits
  after a minute with nothing left.
- **Restarts:** jobs live in `jobs.json`; local stages run detached and write
  their exit code to disk, so results are collected after a restart. A session
  reports results that landed while it was closed.
- **Bounded concurrency:** per backend (`maxConcurrent`) and overall
  (`maxConcurrent` in backends.json, default 4). Queued jobs wait in EZCODER, not
  on GitHub, so they can still be superseded for free.
- **Stale results can't apply to newer code.** Every job is bound to a full SHA;
  `gate` looks only at that SHA. A newer commit on the same branch supersedes
  older queued jobs and cancels running ones (`cancelSuperseded`). Late results
  for a superseded job are ignored. Local stages that ran on uncommitted changes
  (or while HEAD moved) are advisory and never satisfy a gate.
- **Gates:** remote stages post GitHub commit statuses `ezcoder/<stage>`
  (pending → success/failure/error), usable as required checks in branch
  protection. `ezcoder validate gate` exits non-zero unless every required stage
  passed at the commit (use `--wait` in release scripts).
- **Repairs:** a failure arrives as an urgent notification with the failing
  lines and the job id; the agent reads `validate logs <id>`, fixes, commits and
  runs again. Infrastructure problems (worker setup failed, commit not pushed,
  GitHub refused the run for billing) are reported as `error`, not as test
  failures. The one automatic retry is a **lost runner** (see Recovery).
- **Cheap by default:** a stage that already passed at a commit is reused, not
  re-run; superseded runs are cancelled.

## Project config (optional)

Without a file, stages are detected: a compose test file with a `tests` service;
`package.json` (`typecheck`/`check`/`lint` locally, `test` remotely in
`node:22`); rspec, go, cargo or pytest in their official images. Remote stages
on a repo that isn't on GitHub, or with no worker configured, run locally.

`.ezcoder/validation.json`:

```json
{
  "stages": [
    { "name": "lint", "command": "pnpm lint", "run": "local" },
    {
      "name": "models",
      "command": "bin/rails db:create db:schema:load && bundle exec rspec spec/models",
      "setup": "export BMF_DB_ROOT=$RUNNER_TEMP/bmfdb",
      "docker": { "compose": "docker-compose-test.yml", "service": "bmf_app", "entrypoint": "" },
      "timeoutMinutes": 150,
      "resources": { "memoryGb": 8 }
    }
  ],
  "extendDefaults": false,
  "postCommitStatus": true,
  "cancelSuperseded": true
}
```

Stage fields: `run` (`local` | `remote`, default remote), `required` (default:
true for remote), `timeoutMinutes`, `setup`, `docker` (`compose`+`service`
[+`entrypoint`] or `image`), `resources` (`cpus`, `memoryGb`, `labels`),
`backend` (pin a worker id or one pool machine `pool/machine`; normally omitted). `ezcoder validate init` writes the
detected defaults as a starting point.

## Workers (per user, never per project)

`~/.ezcoder/validation/backends.json`, managed with `ezcoder validate add-worker`.
A worker is a repo (e.g. `you/test-worker`) with a `workflow_dispatch` workflow
`remote-test.yml` taking `repo`, `ref`, `command`, `timeout_minutes`, `job_id`
(put it in `run-name`), and optionally `status_context`, `runs_on` (JSON array of
runner labels; default `["self-hosted","linux","ezcoder-docker"]`) and
`cache_key`. It checks out `repo` at `ref`, verifies the SHA, exports `EZ_CACHE`
(a persistent per-project cache dir) and `EZ_MACHINE`, and runs `command` in a
step named **"Run test command"** (EZCODER tells test failures from infra errors
by that name).

### A pool of machines (recommended)

```bash
ezcoder validate add-worker pool --repo you/test-worker --discover
ezcoder validate workers
```

With `"discover": true` the backend is a **pool**: EZCODER reads the repo's
self-hosted runners (`gh api repos/<repo>/actions/runners`, cached ~30 s) that
carry `ezcoder-docker`, and groups them into machines by label. A machine
declares itself only through runner labels:

| Label                               | Meaning                                                        |
| ----------------------------------- | -------------------------------------------------------------- |
| `ezcoder-docker`                    | takes EZCODER jobs                                             |
| `ezw-<machine>`                     | machine id; every runner on that computer carries the same one |
| `ez-cpu-<n>` / `ez-mem-<gb>`        | CPUs / GB of memory for jobs                                   |
| `ez-slots-<n>`                      | concurrent EZCODER jobs (default: online runners)              |
| `linux`, `wsl2`, `macos`, `windows` | platform (usable as stage `resources.labels`)                  |

Each machine is schedulable as `pool/<machine>` and runs are pinned to it with
`runs_on: ["self-hosted","ezcoder-docker","ezw-<machine>"]`. Runners without an
`ezw-` label form one machine named after the pool, using its static
`capacity`/`maxConcurrent`. If the runner list can't be read, the pool falls back
to that static capacity.

**Adding a machine** (no EZCODER change needed):

1. Register one or more self-hosted runners on `you/test-worker` (GitHub →
   Settings → Actions → Runners). Linux: the standard runner as a service, with
   Docker installed. Windows: run it inside **WSL2** (Ubuntu) with Docker
   available there; give it `wsl2` too. Cloud VM: same as Linux.
2. Give every runner on that computer the labels, e.g. for `my-pc`:
   `ezcoder-docker,ezw-my-pc,ez-cpu-16,ez-mem-15,ez-slots-2,linux`
   (`./config.sh --labels …`, or later without touching the machine:
   `gh api -X POST repos/you/test-worker/actions/runners/<id>/labels -f 'labels[]=ezw-my-pc'`).
3. `ezcoder validate workers` shows it within ~30 s.

**Cloud overflow** (off by default; costs Actions minutes):

```bash
ezcoder validate add-worker pool --repo you/test-worker --discover \
  --cloud --cloud-runs-on ubuntu-latest --cloud-max 2 --cloud-when overflow
```

`when: "overflow"` uses GitHub-hosted runners only when no self-hosted machine
is online; `"always"` treats them as one more machine. If GitHub refuses a cloud
run because of an Actions budget, spending limit or billing problem, the job
ends as an `error` ("GitHub Actions budget/billing blocks cloud runners"), cloud
is left out of scheduling for an hour, and the job is queued once more for a
self-hosted machine if one fits.

Full `backends.json` example:

```json
{
  "maxConcurrent": 4,
  "localMaxConcurrent": 2,
  "backends": [
    {
      "id": "pool",
      "kind": "github-actions",
      "repo": "you/test-worker",
      "workflow": "remote-test.yml",
      "discover": true,
      "maxConcurrent": 1,
      "capacity": { "cpus": 4, "memoryGb": 8 },
      "cloud": {
        "enabled": false,
        "runsOn": ["ubuntu-latest"],
        "maxConcurrent": 2,
        "capacity": { "cpus": 4, "memoryGb": 16 },
        "when": "overflow"
      }
    }
  ]
}
```

A backend without `discover` works as before: one worker with static
`capacity`/`maxConcurrent`, dispatched without `runs_on`/`cache_key` (the
workflow's defaults apply). Add `"discover": true` to turn it into a pool.

### Scheduling

A queued remote job goes to the machine that is online, carries the stage's
`resources.labels`, has `capacity` ≥ the stage's `cpus`/`memoryGb`, has a free
slot (slots minus GitHub-busy runners minus our dispatched-not-started runs),
and has enough CPU/memory left after the resources of our in-flight jobs there.
Ties go to the machine that last ran this repo (warm cache), then the lowest
load. Nothing free → the job stays queued in EZCODER (it can still go anywhere,
or be superseded for free). No machine online → cloud overflow if enabled,
otherwise it stays queued and the session is told once that no worker is
online. The global `maxConcurrent` still bounds everything.

### Recovery

A run that ended because its runner was lost (the run failed or was cancelled
while "Run test command" never finished, a runner-lost annotation, a job that
never started, or the run vanished) and that EZCODER didn't cancel goes back to
the queue with `attempts + 1` (at most 3), preferring a different machine. A run
still waiting on a machine that has been offline for over 5 minutes is cancelled
on GitHub and requeued. Each requeue is recorded on the job (`requeues`) and
announced as a non-urgent notification. Cancelled and superseded jobs never
requeue.

### Isolation and caches

Every run gets its own compose project and temp dirs on the worker; jobs of
different projects never share a workspace. Image-mode docker stages mount the
per-project cache: `-v "${EZ_CACHE:-$HOME/.cache/ezcoder-worker/<repo>}":/cache`
with `npm_config_cache`, `npm_config_store_dir` (pnpm), `YARN_CACHE_FOLDER`,
`PIP_CACHE_DIR`, `BUNDLE_PATH`, `GOMODCACHE`, `GOCACHE` and `CARGO_HOME` under
`/cache`. Compose stages manage their own volumes.

`ezcoder validate workers` lists every machine as `pool/machine`: online,
platform, slots used/total, GitHub-busy runners, cpu/memory, resources reserved
by our jobs and infra errors/lost runs in the last 24 h.

## Commands

```bash
ezcoder validate run [stage…] [--ref R] [--force] [--wait]
ezcoder validate status | workers
ezcoder validate gate [--ref R] [--wait]
ezcoder validate logs <id> [--full] | cancel <id> | retry <id>
```

The agent uses the `validate` tool (same actions; loaded via `tool_search`).
