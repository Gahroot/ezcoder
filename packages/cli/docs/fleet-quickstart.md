# Fleet quick start: add a machine in five minutes

Pick the platform of the machine you're adding (the **node**). Your main
machine (the **controller**) needs EZ Coder and Tailscale already.

Before you start, on the node:

- Tailscale installed and signed in to the same tailnet as your main machine
  ([tailscale.com/download](https://tailscale.com/download); on Linux and WSL2: `sudo tailscale up`).
- Docker, if you want containerised jobs, browser runs, renders or services.
- Git access to your repositories with the node's own credentials
  (`gh auth login && gh auth setup-git`, or an SSH key added to your git host).

The bootstrap scripts install Node (user-level, with nvm, only when it's
missing), the CLI, the node config and the run-at-login service. They don't
need root. Run any of them with `--dry-run` first to see every step without
changing anything.

## Linux

On the node:

```sh
curl -fsSLO https://raw.githubusercontent.com/Gahroot/ezcoder/main/packages/cli/scripts/fleet/bootstrap-node-linux.sh
bash bootstrap-node-linux.sh --dry-run          # optional: see what it will do
bash bootstrap-node-linux.sh --name gpu-box     # also: --labels a,b  --slots N  --tls  --version V  --no-service
ezcoder node doctor --repo https://github.com/you/repo
ezcoder node pair --code
```

The script runs `ezcoder node init`, then `ezcoder node install` and
`systemctl --user enable --now ezcoder-node`, so the node starts at login.
To keep it running while you're logged out, run
`sudo loginctl enable-linger $USER` once.

## Windows (WSL2)

The node runs inside WSL2, not in native Windows.

1. In an admin PowerShell: `wsl --install -d Ubuntu`, then open Ubuntu.
2. Turn on systemd so the node can run as a service. Put this in `/etc/wsl.conf`:
   ```ini
   [boot]
   systemd=true
   ```
   Then run `wsl --shutdown` from Windows and open Ubuntu again.
3. Docker: Docker Desktop with WSL integration turned on for Ubuntu, or Docker
   Engine installed inside Ubuntu. For an NVIDIA GPU, install only the normal
   Windows driver.
4. Inside Ubuntu, run the same commands as for Linux above
   (`bootstrap-node-linux.sh`, then `ezcoder node doctor` and `ezcoder node pair --code`).

WSL shuts down when no Windows program uses it. `ezcoder node install` prints a
one-line `.vbs` script; save it in the Windows Startup folder
(`Win+R`, then `shell:startup`) to keep the node running. Keep your work in the
Linux file system (`~`), not under `/mnt/c`.

If systemd is off, the script says so and installs no service. Turn systemd on
(step 2) and run `ezcoder node install`, or start the node yourself with
`ezcoder node serve`.

## macOS

On the node:

```sh
curl -fsSLO https://raw.githubusercontent.com/Gahroot/ezcoder/main/packages/cli/scripts/fleet/bootstrap-node-macos.sh
bash bootstrap-node-macos.sh --dry-run          # optional
bash bootstrap-node-macos.sh --name old-mac
ezcoder node doctor --repo https://github.com/you/repo
ezcoder node pair --code
```

The script runs `ezcoder node init`, writes the LaunchAgent
`~/Library/LaunchAgents/dev.ezcoder.node.plist` with `ezcoder node install`, and
loads it with `launchctl bootstrap`. Docker on macOS can't pass the GPU into
containers; use host-shell jobs for Metal work.

## Pair it from your main machine

`ezcoder node pair --code` prints a short code (for example `K7QM-2XPA`, valid
10 minutes, works once) and a QR code of the full pairing string. On your main
machine, either:

```sh
ezcoder fleet add --code K7QM-2XPA                 # finds the node on the tailnet
ezcoder fleet add --code K7QM-2XPA --host gpu-box  # or name it
```

or paste the full pairing string at the prompt, so the token never lands in your
shell history:

```sh
ezcoder node pair        # on the node: prints ezfleet://gpu-box@gpu-box.your-tailnet.ts.net:7377#<token>
ezcoder fleet add        # on the main machine: asks for it (input hidden)
```

`fleet add` checks that it can reach the node and that the token works, then
shows the node's doctor report. It refuses to pair otherwise, unless you pass
`--offline`. Then:

```sh
ezcoder fleet nodes      # online, slots, CPU and memory, GPUs, labels
```

For a machine that should only run containers (for repositories you trust
less), add `--docker-only` to `ezcoder node init`.

That's it. Builds, tests, validation stages, helper agents and Goal workers can
now use the node. See [fleet.md](fleet.md) for what to send it.

## Without Tailscale (TLS)

If you can't use Tailscale, serve https instead. Use `bootstrap-node-*.sh --tls`,
or run `ezcoder node init --tls --host <address>` (makes a self-signed
certificate with openssl). To use your own certificate, run
`ezcoder node init --tls-cert FILE --tls-key FILE`.

The pairing string then starts with `ezfleets://` and ends with the
certificate's fingerprint (`;fp=<64 hex>`). The main machine pins that
certificate and refuses any other. Pairing codes work the same way.

## By hand, without the script

Install Node 22 or newer, then the `@prestyj/cli` package from npm, then:

```sh
ezcoder node init --name gpu-box
ezcoder node install             # prints the systemctl or launchctl command to run
ezcoder node doctor
```
