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
  worker offline) are reported as `error`, not as test failures, and are never
  retried automatically.
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
`backend` (pin a worker; normally omitted). `ezcoder validate init` writes the
detected defaults as a starting point.

## Workers (per user, never per project)

`~/.ezcoder/validation/backends.json`, managed with:

```bash
ezcoder validate add-worker my-pc --repo you/test-worker \
  --workflow remote-test.yml --max 1 --labels self-hosted --cpus 16 --memory-gb 15
ezcoder validate workers      # health (runner online/busy), load, recent infra errors
```

A worker is any repo with a `workflow_dispatch` workflow taking `repo`, `ref`,
`command`, `timeout_minutes`, `job_id` (put it in `run-name`) and optionally
`status_context`. The workflow checks out `repo` at `ref`, verifies the SHA,
runs `command` with a timeout, and (optionally) posts the `status_context` commit status.
A cloud backend is another entry pointing at a workflow that uses GitHub-hosted
(or other) runners. Jobs go to the least-loaded worker whose declared capacity
fits the stage; adding a worker adds capacity for every project.

## Commands

```bash
ezcoder validate run [stage…] [--ref R] [--force] [--wait]
ezcoder validate status | workers
ezcoder validate gate [--ref R] [--wait]
ezcoder validate logs <id> [--full] | cancel <id> | retry <id>
```
The agent uses the `validate` tool (same actions; loaded via `tool_search`).
