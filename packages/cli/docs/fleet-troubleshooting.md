# Fleet troubleshooting

Find the message you saw (search this page for a few words of it). Parts in
`<angle brackets>` are filled in by the product. `node <name> (<url>)` is how
the main machine names a node, for example `node gpu-box (http://gpu-box.tailnet.ts.net:7377)`.

Start with `ezcoder node doctor --repo <your repo URL>` on the node. It checks
Tailscale, Docker, GPU passthrough, git access, model login, disk, slots and the
keychain, and prints one `fix:` line under each problem.

## Pairing and connecting

**``node <name> (<url>) is unreachable (<why>); is it online and on the tailnet, and is `ezcoder node serve` running?``**
The main machine got no answer. Check that the node is awake, that
`tailscale status` lists it on both machines, and that the service runs
(`systemctl --user status ezcoder-node` on Linux and WSL2). On WSL2, make sure the
Startup `.vbs` script keeps WSL running.

**`node <name> (<url>) did not answer within <n> s`**
The node is reachable but slow or stuck. Look at its log
(`journalctl --user -u ezcoder-node` on Linux) and restart the service.

**`not pairing <name>: <why>. Fix that and try again, or pair anyway with --offline`**
`fleet add` checks the node before saving it. Fix the reason it gives, or pass
`--offline` to pair a node that is off right now.

**`` node <name> (<url>) rejected our token; pair again with `ezcoder fleet add <pairing string>` ``**
The token was rotated or the node was set up again. On the node run
`ezcoder node pair`, then `ezcoder fleet add` on the main machine.

**`node <name> (<url>) is not an EZCODER node`**
Something else answers on that address and port. Check the host and port in the
pairing string (the default port is 7377).

**`pairing token is too short`** / **`no pairing string given`**
The string was cut off when you copied it. Copy the whole line that
`ezcoder node pair` prints, or use `ezcoder node pair --code`.

**``node <name> (<url>) did not accept the pairing code: it is wrong, expired (codes last 10 minutes) or already used; run `ezcoder node pair --code` on that machine for a new one``**
Make a new code on the node and use it within 10 minutes. Each code works once.

**`node <name> (<url>) refused: too many wrong attempts; wait 10 minutes and try again`**
After 5 wrong codes in 10 minutes the node stops accepting codes for a while.
Wait, then use a fresh code.

**`no unpaired EZ Coder node found on the tailnet to use the code with; pass --host <address of the other machine>`**
Discovery didn't find the node. Pass its tailnet name or IP:
`ezcoder fleet add --code <code> --host gpu-box`.

**``node <name> speaks fleet protocol <n> and this machine needs <range>; update the node: run `ezcoder node update` on <name>``**
The node runs an older EZ Coder. Run `ezcoder node update` on the node, or
`ezcoder fleet update <name>` from the main machine.

**``node <name> speaks fleet protocol 1 and this machine needs 2; update the node: on <name> run `npm i -g @prestyj/cli@latest`, then restart `ezcoder node serve` (or its login service)``**
The node runs an EZ Coder from before `ezcoder node update` existed. On the
node, run `npm i -g @prestyj/cli@latest`, then restart it: stop and start
`ezcoder node serve`, or `systemctl --user restart ezcoder-node` (Linux, WSL2)
or `launchctl kickstart -k gui/$(id -u)/dev.ezcoder.node` (macOS) if it runs at
login. From then on `ezcoder fleet update <name>` works from the main machine.

**`node <name> speaks fleet protocol <n>, newer than this machine's <n>; update EZ Coder on this machine`**
The main machine is the older side. Update the CLI on this machine.

**`this node speaks fleet protocol <range> but the controller speaks <n>: update EZ Coder on the controller (npm i -g @prestyj/cli@latest)`**
**`the controller speaks fleet protocol <n> but this node only <range>: update the node (ezcoder node update)`**
The same mismatch, as the node reports it (HTTP 426). Update the side it names.

**`node <name> (<url>) presented a different TLS certificate than the one it was paired with (expected sha-256 <…>, got <…>); nothing was sent. Someone may be intercepting the connection, or the node made a new certificate: if you trust it, pair again with its new pairing string`**
With TLS the main machine pins the node's certificate. If you made a new
certificate on the node (`ezcoder node init --tls` again), run
`ezcoder node pair` there and pair again. If you didn't, don't pair: something
between the two machines is answering instead of the node.

**`TLS pairing string needs the node's certificate fingerprint: ezfleets://<name>@<host>:<port>#<token>;fp=<64 hex>`**
**`a certificate fingerprint (;fp=) needs an ezfleets:// (TLS) pairing string`**
The pairing string was edited or cut off. Copy it again from `ezcoder node pair`.

## Starting the node

**``Tailscale is not running, so there is no private address to listen on. Start Tailscale (`sudo tailscale up`), or pass --bind <ip> explicitly.``**
Start Tailscale on the node. The node listens only on its tailnet address.

**`refusing to listen on every interface (<addr>). The node runs commands for anyone with its token; keep it on the tailnet. If you really mean it: --bind 0.0.0.0 --insecure-bind`**
**``refusing to listen on <addr>: it is not a Tailscale or loopback address, so the token, your code and any shared credentials would cross that network unencrypted. Serve https instead (`ezcoder node init --tls`), or if you really mean it, add --insecure-bind``**
The node won't serve plain http on a LAN or public address. Use Tailscale, or
TLS (`ezcoder node init --tls`).

**`  ! Tailscale is not running here. Install/start it (https://tailscale.com/download),`** (from `node init`)
`node init` prints no pairing string without Tailscale or TLS, so a token is
never paired to an address off the tailnet. Start Tailscale and run
`ezcoder node init` again.

**`openssl is not installed, so no certificate can be made. Install openssl, or pass your own with --tls-cert FILE --tls-key FILE`**
Install openssl (`sudo apt install openssl`), or bring your own certificate.

**`TLS needs both a certificate and a key: pass --tls-cert FILE --tls-key FILE`**
**`use --tls (a self-signed certificate) or --tls-cert/--tls-key, not both`**
Pass both files, or use `--tls` alone.

**``this machine is not a fleet node yet: run `ezcoder node init` first``**
Run `ezcoder node init` (or the bootstrap script) on this machine.

**`slots must be a whole number of at least 1`**
`ezcoder node config --slots N` takes 1 or more.

**`run the node inside WSL2 on Windows (see the fleet-nodes docs)`**
Native Windows can't be a node. Follow the WSL2 steps in
[fleet-quickstart.md](fleet-quickstart.md).

## Sending work

**``this repo has no `origin` remote; nodes clone the code from it (add one and push first)``**
Nodes fetch code from `origin` with their own credentials. Add a remote and push.

**`commit <sha> isn't on origin; push first (or include uncommitted work with --uncommitted / includeUncommitted)`**
**`Local HEAD <sha> is not on origin yet, so the other machine can't check it out. Push it first (git push), or leave machine unset to run the agent locally.`**
Push your branch. Local edits travel as a patch, but the base commit must be on `origin`.

**`commit <sha> not found in <repo> (is it pushed?)`** / **`git fetch failed: <git output>`**
The node couldn't fetch the commit. Run `ezcoder node doctor --repo <url>` on
the node. Its `git` check names the fix, usually `gh auth login && gh auth setup-git`
or adding the node's SSH key to your git host.

**`git submodules could not be initialised: <git output>. Make sure this node can reach every submodule's remote with its own git credentials, or send the job with source.submodules: false (".ezcoder/fleet.json")`**
Give the node access to every submodule's repository, or turn submodules off for that job.

**`Uncommitted changes are <n> MB (limit 50 MB). Commit and push them, or run locally.`**
Commit and push the large files. Patches are capped at 50 MB.

**`node <name> (<url>) runs only Docker work (it was started with --docker-only): give the job a Docker image; remote agents and host-shell jobs can't run there`**
**`this node only runs containerised work (docker-only): give the job a docker image, or use another node`**
**`this node only runs containerised work (docker-only) and does not host remote agents; use another node`**
The node is limited to containers. Add `"docker": { "image": "…" }` to the job
in `.ezcoder/fleet.json`, or send agents to another node.

**`docker host mount not allowed: <path> (only this job's own workspace and cache can be mounted; use a named volume)`**
A job may mount only its own workspace and its own cache folder. Use a named
volume (`-v name:/path`) for anything else.

**`node <name> (<url>) is full`** / **`all slots are busy`**
Every slot on the node is in use. The main machine waits as long as the node
asks (`Retry-After`), then tries again; you don't have to do anything. To run
more at once, raise the node's slots: `ezcoder node config --slots N`.

**`<…> Gave up after waiting for a free slot.`**
An agent waited 6 hours for a slot and gave up. Free slots or raise them.

**``No fleet nodes are paired. Pair one with `ezcoder fleet add`, or leave machine unset to run locally.``**
Pair a node first, or drop the `machine` option.

**`No paired machine can run an agent now (<reasons>).`**
**`No paired machine can run a Goal worker now (<reasons>).`**
The reasons list each node's problem: offline, no model login, wrong protocol,
docker-only. Fix the one you want to use.

**``secret not set on this node: <names> (set it there with `ezcoder node secret set NAME`)``**
On the deploy node: `printf %s "$VALUE" | ezcoder node secret set NAME`.

**`deploy blocked: required validation hasn't passed at <sha> (<stages>). Run validate run, wait for it to pass, then deploy again.`**
Deploys run only after validation passed for that exact commit.

**`deploy runs exact pushed commits only; commit and push, then deploy without --uncommitted`**
Deploys never use patches. Push first.

## Model login and secrets

**``no model credentials on this machine (run `ezcoder login` first)``**
`share-auth` copies your login from this machine, so sign in here first. The
better fix is usually `ezcoder login` on the node itself.

**``<name> already has its own model login, so nothing was changed. To replace it with this machine's, share again with force (`ezcoder fleet share-auth <name> --yes --force`); safer: keep the node's own login``**
**`this node already has its own credentials for <providers>; pass --force to replace them`**
The node is already signed in. Keep its own login, or pass `--force`.
A subscription login shared to two machines can sign one of them out when the
other refreshes it.

**``no OS keychain is available on this machine, so deploy secrets can't be stored safely. On Linux install the Secret Service tools and a keyring (e.g. `sudo apt install libsecret-tools gnome-keyring`); on macOS run this from a logged-in user session. Secrets are never written to a plain file.``**
Deploy secrets live only in the OS keychain. On a headless Linux box, install
`libsecret-tools` and `gnome-keyring` and run the node in a session with D-Bus.
On macOS, unlock the login keychain (`security unlock-keychain`).

**`<file> holds deploy secrets in plain text and there is no keychain to move them into; jobs can't use them until there is. …`**
An old `secrets.json` was found. Set up a keychain as above. The next
`ezcoder node serve` moves the secrets in and deletes the file, and logs
`moved <n> deploy secret(s) (<names>) from <file> into the <keychain> and deleted the file`.

## Goals on the fleet

**`Goal "<title>" already has <n> worker(s) on fleet nodes (max_remote_workers=<n>). Wait for one to finish or raise the cap.`**
The Goal's own cap on remote workers was reached. Raise `max_remote_workers`,
or let a worker finish.

**`Edits from <node> conflict with this folder in: <files>. None of this worker's edits were applied; its patch is saved at <path>. Apply by hand with: git apply --3way --binary "<path>"`**
Another worker (or you) changed the same lines first. The task fails rather
than mixing edits. Apply the saved patch by hand, or run the task again.

**`Machine "<name>" is unreachable: <why>`**
The same as the node unreachable message above, for Goal work.

## Doctor checks

Each failed or warning line from `ezcoder node doctor` ends with its fix. The
most common ones:

| Check       | Says                                                                                | Fix it prints                                                                                                                          |
| ----------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| tailscale   | `not running, so the main machine can't reach this node privately`                  | `` install Tailscale (https://tailscale.com/download) and run `sudo tailscale up` ``                                                   |
| docker      | `not installed: containerised jobs, browser runs and services can't run here`       | ``install Docker (https://docs.docker.com/engine/install/), then run `ezcoder node doctor` again``                                     |
| docker      | `installed but not usable: … permission denied …`                                   | ``add yourself to the docker group: `sudo usermod -aG docker $USER`, then log out and back in``                                        |
| gpu         | `<gpu>, but Docker has no NVIDIA runtime, so containers can't use it`               | `` install the NVIDIA Container Toolkit, then `sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker` `` |
| git         | `can't read <repo>: …`                                                              | `` sign in to your git host on this machine: `gh auth login && gh auth setup-git` `` (or the SSH key fix for ssh URLs)                 |
| model_login | `no model login, so remote agents and Goal workers can't run here (jobs still can)` | ``run `ezcoder login`on this machine, or`ezcoder fleet share-auth <node>` from the main machine``                                      |
| disk        | `<n> GB free in <folder>`                                                           | ``free disk space, or lower `ezcoder node config --gc-days N` so old jobs are removed sooner``                                         |
| keychain    | `no keychain, so deploy secrets can't be stored or read`                            | ``install a keyring: `sudo apt install libsecret-tools gnome-keyring` (needs a D-Bus session)``                                        |
