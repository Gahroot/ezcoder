# Cloud capacity: Claude Code cloud and Codex cloud

When your own machines are busy, full or off, EZ Coder can send work to the
cloud sandboxes that come with your Claude or ChatGPT plan. Nothing to install
or configure: if you're signed in to Claude (or ChatGPT) in EZ Coder, that
provider is connected automatically.

| Use                      | Claude Code cloud | Codex cloud |
| ------------------------ | ----------------- | ----------- |
| Validation stages        | yes (overflow)    | no          |
| Fleet jobs (build, test) | yes (overflow)    | no          |
| Helper agents            | yes               | yes         |

Codex records no command output EZ Coder can check, so its results can't be
proven; it never runs test gates or jobs, only helper agents.

**Order.** When both can take a helper agent, Codex goes first, which saves
your Claude plan for interactive coding. `ezcoder cloud prefer claude`
reverses that. Test gates and jobs always use Claude Code cloud, because only
its results can be checked.

## How it fits in

- **Overflow by default.** A stage or job goes to the cloud only when no
  machine of yours has room for it, including when your machines are online but
  full. A free slot on your own machine always wins. `ezcoder cloud when always`
  makes the cloud one more machine; `manual` uses it only when a stage or job
  names it (`backend: "cloud"`, fleet `node: "claude-cloud"`).
- **Exact code.** The tested commit is uploaded as a one-commit git bundle (no
  push needed). The sandbox checks it has exactly that code before running.
- **Results you can trust.** The sandbox's model is told to run one exact
  command. A result counts only when the cloud's own record of that command and
  its output shows our marker with this job's id and the right code; anything
  else (a summary, an edited command, other code) is not trusted and the job
  moves to another machine.
- **Never blocks you.** Like every validation job it runs in the background;
  `ezcoder/<stage>` commit statuses and gates work the same as on your PC.
- **Plan aware.** EZ Coder reads your plan's weekly usage from every session and
  stops sending work past 80% (`ezcoder cloud limit 60` to change it). If the
  plan's limit is hit, the provider is paused until it resets and queued work
  waits for your machines.

## What a Claude Code cloud sandbox is (measured)

|          |                                                                                                    |
| -------- | -------------------------------------------------------------------------------------------------- |
| Machine  | Ubuntu 24.04, 4 vCPU, 16 GB RAM, ~60 GB disk, no GPU, runs as root                                 |
| Tools    | Node 22, pnpm, bun, Python 3.11, Go, Rust, Java, Ruby, Postgres/Redis clients, Chrome + Playwright |
| Docker   | Started on demand for stages that use it (~5 s); Docker Hub images work                            |
| Network  | Package registries and Docker Hub only (no general internet)                                       |
| Speed    | First command ~10 s after submit; a small stage's result in ~15 s                                  |
| Parallel | 10 sessions at once ran without waiting                                                            |
| Cost     | Counts toward your plan; a test stage is one short turn on Haiku                                   |

So the cloud fits Linux stages up to 4 CPUs / 16 GB. Stages that need a GPU,
Windows, macOS, more resources, secrets or general internet stay on your
machines. Tests that depend on not being root (read-only files) can fail there:
pin those stages to your own machines.

## Commands

```bash
ezcoder cloud                      # status: connected?, account, plan use, what it runs
ezcoder cloud off | on [claude|codex]
ezcoder cloud use validation,jobs,agents
ezcoder cloud prefer codex|claude  # which provider gets work first (default codex)
ezcoder cloud when overflow|always|manual
ezcoder cloud limit 80             # stop at this % of the weekly plan
ezcoder cloud setup claude         # create the default Claude Code cloud environment
ezcoder cloud setup codex          # connect GitHub to Codex once, then automatic
```

`ezcoder validate workers` and `ezcoder fleet nodes` list the cloud next to your
machines. Settings live in `~/.ezcoder/cloud.json`; turn validation's cloud off
per user with `"cloud": false` in `~/.ezcoder/validation/backends.json`.

## Helper agents in the cloud

`spawn_agent` with `machine: "claude-cloud"` or `"codex-cloud"` runs a helper
in that cloud; `"cloud"` picks the first available, and `"auto"` uses a paired
machine first and the cloud when none can take it. The helper starts from your
current code, including uncommitted changes (files that look like secrets, such
as `.env`, are left out). Its edits come back to your folder after each turn,
like a fleet agent's; a patch that doesn't apply cleanly is kept aside.

Codex cloud needs one approval only you can give: GitHub access for Codex.
`ezcoder cloud setup codex` opens Codex's connect page, waits while you click
Connect and approve on github.com, then creates this repository's environment.
After that it's automatic: any other GitHub repo you use gets its environment
on first use, with the same defaults as Codex's own one-click setup (its
standard image, agent internet off, private to you). Codex tasks start from the
pushed branch plus your local changes, and EZ Coder reads the Codex plan's
weekly meter so the plan cap applies to it too.
