# Fleet nodes: run EZCODER work on your other machines

A **fleet node** is any machine of yours running `ezcoder node serve`. Your main
machine (the controller) sends it jobs (builds, tests, browser runs, renders,
deploys), long-running services (local LLMs, remote Playwright browsers, dev
environments) and whole sub-agents. Nodes are reached over
[Tailscale](https://tailscale.com), so no ports are opened to the internet.

Examples below use generic names: a Linux box `gpu-box`, a Windows PC `my-pc`,
a repo `you/repo`. For the fastest path use the bootstrap scripts in the
[quick start](fleet-quickstart.md); this page explains each piece.

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

`ezcoder node pair` prints the string again, and `ezcoder node pair --code`
prints a short single-use code (10 minutes) and a QR code instead
(`ezcoder fleet add --code <code>` on the main machine). `ezcoder node status`
shows the config and, while serving, live load, GPUs, slots and running work.
`ezcoder node doctor [--repo URL]` checks Tailscale, Docker, GPU passthrough,
git access, model login, disk, slots and the keychain, with one fix per problem.

Slots are shared by every kind of work on the node: jobs, validation stages,
helper agents and Goal workers. They default to
`max(1, min(cpus/2, memoryGb/2))`. Change them with
`ezcoder node config --slots N`; a running node picks the change up at once.
Services do not use slots. A full node answers "busy" with a `Retry-After`
time, and the controller keeps the work queued until a slot frees. See
[Capacity](fleet.md#capacity).

### Settings

```bash
ezcoder node config                       # show them
ezcoder node config --slots 8             # any N >= 1
ezcoder node config --gc-days 3           # remove finished work older than this (default 7)
ezcoder node config --cache-cap-gb 50     # trim caches beyond this, oldest-used first (default 20)
```

To limit a node to containerised work, use `ezcoder node init --docker-only`
(saved in `node.json`) or `ezcoder node serve --docker-only` (for that run).
The node then refuses host-shell jobs and helper agents, and says so in its
hello, so the main machine doesn't send them there.

### TLS instead of Tailscale

`ezcoder node init --tls --host <address>` makes a self-signed certificate
with openssl. `--tls-cert FILE --tls-key FILE` uses your own. The pairing
string becomes `ezfleets://<name>@<host>:<port>#<token>;fp=<sha-256>`, and the
main machine pins that certificate.

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

`ezcoder node uninstall` removes the login service again; `--purge` also deletes
the data folder and the node's deploy secrets, and says what it removed.

### Updating

```bash
ezcoder node update                 # latest; or --version V
ezcoder fleet update gpu-box        # the same, from the main machine
```

The node installs the CLI with npm, then restarts its login service. It refuses
while jobs or agents run, unless you pass `--force`.

### Restarts and cleanup

Jobs run detached: restarting the node (or its service) does not kill them.
On start the node re-adopts running jobs (by pid or Docker label) and marks
ones it cannot find as `lost`, which the controller requeues elsewhere
(except deploys). Helper-agent workspaces are re-adopted too. A worker that
stopped with the node is marked `error`, and its workspace is kept so its edits
can still be fetched.

While running, the node removes finished jobs, logs and artifacts older than
`gcDays` and trims caches beyond `cacheCapGb`. It never touches running work.
Each job's log is capped (200 MB by default); past the cap the start and the
end are kept and the middle is dropped.

## 4. Model credentials for remote agents

Remote sub-agents use the node's own `~/.ezcoder/auth.json`. Either run
`ezcoder login` on the node, or opt in from the main machine with
`ezcoder fleet share-auth gpu-box --yes`, which sends your provider credentials over
Tailscale once. Nothing is shared automatically, and credentials the node
already has are kept unless you add `--force`.

## 5. Secrets for deploys

Deploy secrets never leave the node and are never sent by the controller.

```bash
ezcoder node init --labels deploy          # only "deploy" nodes accept secrets
printf %s "$DEPLOY_TOKEN" | ezcoder node secret set DEPLOY_TOKEN
ezcoder node secret list                   # names only
ezcoder node secret rm DEPLOY_TOKEN
```

Values are stored in the OS keychain: the macOS keychain, or Secret Service
(`secret-tool`) on Linux. Only the names are written to
`~/.ezcoder/node/secret-names.json`. Without a keychain, `secret set` refuses;
there is no plain-text fallback. On a headless Linux box install
`libsecret-tools` and `gnome-keyring`. An old plain-text `secrets.json` is moved
into the keychain, then deleted, the next time the node starts. A project's
job names the secrets it needs (`"secrets": ["DEPLOY_TOKEN"]`) and the node
exposes them as environment variables for that job only. Jobs of any other kind
that ask for secrets are refused. Inside Docker they are
passed with `-e NAME`, so values never appear on a command line. Deploy jobs
also need the project's required validation to have passed for the exact
commit, and they are never retried automatically.

## 6. Security model

See [fleet-security.md](fleet-security.md): what the token grants, the network
rules, Docker and mount limits, docker-only nodes, the environment allow-list,
keychain secrets and TLS pinning, each with the test that proves it.

## Data layout

```
~/.ezcoder/node/
  node.json        name, token, port, bind, labels, slots, TLS files, GC settings (0600)
  secret-names.json  names of deploy secrets (values are in the OS keychain)
  state.json       jobs, services and agents, for re-adoption after restarts
  agents/<id>      helper-agent workspaces
  jobs/<id>        job workspaces (removed when the job ends)
  tls/             self-signed certificate and key from `init --tls`
  run/<id>         job logs and exit files
  artifacts/<id>   collected artifacts
  services/<id>    service workspaces
  cache/<key>      per-project package caches (/cache in Docker, $EZ_CACHE on the host)
```
