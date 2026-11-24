# Fleet nodes: run EZCODER work on your other machines

A **fleet node** is any machine of yours running `ezcoder node serve`. Your main
machine (the controller) sends it jobs (builds, tests, browser runs, renders,
deploys), long-running services (local LLMs, remote Playwright browsers, dev
environments) and whole sub-agents. Nodes are reached over
[Tailscale](https://tailscale.com), so no ports are opened to the internet.

Examples below use generic names: a Linux box `gpu-box`, a Windows PC `my-pc`,
a repo `you/repo`.

## 1. Install on the node

All platforms need Node.js 22+, git, and (for Docker jobs/services) Docker.

```bash
npm i -g @prestyj/cli
```

Give the node access to your repositories with its own credentials
(`gh auth login`, or an SSH key added to your Git host). The node clones code
itself; the controller never sends git credentials.

### Linux

- Install Docker Engine and add yourself to the `docker` group
  (`sudo usermod -aG docker $USER`, then log in again).
- NVIDIA GPU: install the driver and the
  [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/),
  then check `docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi`.
  AMD GPUs are detected via `rocm-smi`.

### Windows (WSL2)

The node runs inside WSL2 (Ubuntu recommended), not in native Windows.

1. `wsl --install -d Ubuntu` in an admin PowerShell, then open Ubuntu.
2. Enable systemd so the node can run as a service: put
   ```ini
   [boot]
   systemd=true
   ```
   in `/etc/wsl.conf`, then run `wsl --shutdown` from Windows and reopen Ubuntu.
3. Docker: either Docker Desktop with _WSL integration_ enabled for your
   distro, or Docker Engine installed directly inside Ubuntu.
4. NVIDIA GPU: install the normal **Windows** NVIDIA driver only (never a Linux
   driver inside WSL). `nvidia-smi` then works inside Ubuntu. Docker Desktop
   passes GPUs through out of the box; with Docker Engine inside WSL also install
   the NVIDIA Container Toolkit.
5. Install Node.js 22+ and the CLI inside Ubuntu, as on Linux.

Keep the work inside the Linux filesystem (`~`), not under `/mnt/c`: it is much
faster. The node detects WSL2 itself (`platform: "wsl2"`).

### macOS

- Docker Desktop (or OrbStack/Colima) for Docker jobs.
- Apple silicon GPUs are reported (unified memory), but Docker on macOS cannot
  pass the GPU into containers; use host-shell jobs for Metal work.

## 2. Tailscale

Install Tailscale on the node and on your main machine
([tailscale.com/download](https://tailscale.com/download)) and sign both in to
the same tailnet (on Linux/WSL2: `sudo tailscale up`). Enabling MagicDNS gives
nodes names such as `gpu-box.your-tailnet.ts.net`.

The node listens only on its Tailscale IP (`tailscale ip -4`). If Tailscale is
not running, `ezcoder node serve` stops with an error instead of falling back to
another interface.

## 3. Create, serve and pair

```bash
ezcoder node init --name gpu-box --labels render --slots 2
ezcoder node serve
```

`init` writes `~/.ezcoder/node/node.json` (name, token, port 7377, labels,
slots) and prints a pairing string:

```
ezfleet://gpu-box@gpu-box.your-tailnet.ts.net:7377#<token>
```

On your main machine:

```bash
ezcoder fleet add 'ezfleet://gpu-box@gpu-box.your-tailnet.ts.net:7377#<token>'
```

`ezcoder node pair` prints the string again; `ezcoder node status` shows the
config and, while serving, live load, GPUs, slots and running work.

Slots (concurrent jobs + agents) default to `max(1, min(cpus/4, memoryGb/4))`.
Services do not use slots. A full node answers `429` and the controller picks
another node.

### Run at login

```bash
ezcoder node install
```

- **Linux / WSL2 with systemd**: writes `~/.config/systemd/user/ezcoder-node.service`
  and prints `systemctl --user enable --now ezcoder-node` plus
  `sudo loginctl enable-linger <you>` (it never runs sudo for you).
- **WSL2**: WSL shuts down when no Windows program uses it. `install` also prints
  a one-line `.vbs` script to save in the Windows Startup folder
  (`Win+R` → `shell:startup`), which keeps the distro, and so the node, running.
- **macOS**: writes `~/Library/LaunchAgents/dev.ezcoder.node.plist` and prints the
  `launchctl bootstrap` command.

Jobs run detached: restarting the node (or its service) does not kill them.
On start the node re-adopts running jobs (by pid or Docker label) and marks
ones it cannot find as `lost`, which the controller requeues elsewhere
(except deploys).

## 4. Model credentials for remote agents

Remote sub-agents use the node's own `~/.ezcoder/auth.json`. Either run
`ezcoder login` on the node, or opt in from the main machine with
`ezcoder fleet share-auth gpu-box`, which sends your provider credentials over
Tailscale once. Nothing is shared automatically.

## 5. Secrets for deploys

Deploy secrets never leave the node and are never sent by the controller.

```bash
ezcoder node init --labels deploy          # only "deploy" nodes accept secrets
printf %s "$DEPLOY_TOKEN" | ezcoder node secret set DEPLOY_TOKEN
ezcoder node secret list                   # names only
ezcoder node secret rm DEPLOY_TOKEN
```

Secrets are stored in `~/.ezcoder/node/secrets.json` (mode 0600). A project's
job names the secrets it needs (`"secrets": ["DEPLOY_TOKEN"]`) and the node
exposes them as environment variables for that job only. Inside Docker they are
passed with `-e NAME`, so values never appear on a command line. Deploy jobs
also need the project's required validation to have passed for the exact
commit, and they are never retried automatically.

## 6. Security model

- **Network**: the node binds to its Tailscale address. Binding `0.0.0.0` is
  refused unless you pass both `--bind 0.0.0.0` and `--insecure-bind`. Service
  ports are published on the same address.
- **Auth**: every call except `GET /v1/hello` needs `Authorization: Bearer <token>`,
  compared in constant time. Anyone with the token can run commands as your user
  on the node, so treat the pairing string like a password. To rotate it, delete
  `token` from `node.json`, run `ezcoder node init`, then re-add the node on the
  controller.
- **Isolation**: each job, agent and service gets its own workspace under
  `~/.ezcoder/node/{jobs,agents,services}/<id>` and its own container named
  `ezf-<id>`, labelled `ezcoder.fleet=<id>`. Cleanup only touches those labels.
  Host-shell jobs run as your user without a sandbox; use Docker jobs for code
  you trust less.
- **Docker limits**: `--privileged`, `--cap-add`, host network/PID/IPC
  namespaces, unconfined security profiles, the Docker socket and host-path
  mounts (other than the node's own data folder) are rejected. Use named volumes.
- **Limits**: request bodies are capped at 64 MB (patches at 50 MB), artifacts
  at 10 GB per job; jobs stop at their timeout.
- **Logs**: the node never logs tokens, secret values or credentials, only names.

## Data layout

```
~/.ezcoder/node/
  node.json        name, token, port, bind, labels, slots
  secrets.json     deploy secrets (0600)
  state.json       jobs and services, for re-adoption after restarts
  jobs/<id>        job workspaces (removed when the job ends)
  run/<id>         job logs and exit files
  artifacts/<id>   collected artifacts
  services/<id>    service workspaces
  cache/<key>      per-project package caches (/cache in Docker, $EZ_CACHE on the host)
```
