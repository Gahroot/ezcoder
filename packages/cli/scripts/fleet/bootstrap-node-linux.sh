#!/usr/bin/env bash
# One-command setup of an EZ Coder fleet node on Linux or WSL2 (S8).
#   curl -fsSLO https://raw.githubusercontent.com/Gahroot/ezcoder/main/packages/cli/scripts/fleet/bootstrap-node-linux.sh
#   bash bootstrap-node-linux.sh --dry-run      # see every step first
#   bash bootstrap-node-linux.sh --name gpu-box --labels gpu,render
# Installs Node (user-level, via nvm) when missing, the ezcoder CLI, makes the
# node config and installs the run-at-login service (systemd --user). Nothing
# needs root. --dry-run prints every step without changing anything.
set -euo pipefail

NODE_MAJOR=22
NVM_VERSION=v0.40.1
CLI_VERSION=latest
DRY_RUN=0
SERVICE=1
INIT_ARGS=()

usage() {
  cat <<'USAGE'
usage: bootstrap-node-linux.sh [--dry-run] [--version V] [--name N] [--labels a,b]
                               [--slots N] [--tls] [--no-service]
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --version)
      CLI_VERSION="${2:?--version needs a value}"
      shift
      ;;
    --name | --labels | --slots)
      INIT_ARGS+=("$1" "${2:?$1 needs a value}")
      shift
      ;;
    --tls) INIT_ARGS+=("--tls") ;;
    --no-service) SERVICE=0 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

say() { printf '==> %s\n' "$*"; }
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

if [ "$(uname -s)" != "Linux" ]; then
  if [ "$DRY_RUN" = 1 ]; then
    say "not Linux ($(uname -s)); continuing because this is a dry run"
  else
    echo "this script is for Linux and WSL2; on macOS use bootstrap-node-macos.sh" >&2
    exit 1
  fi
fi
if grep -qi microsoft /proc/version 2>/dev/null; then
  say "WSL2 detected"
fi

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge "$NODE_MAJOR" ]
}

if node_ok; then
  say "Node $(node --version) found"
else
  say "installing Node $NODE_MAJOR for this user with nvm $NVM_VERSION"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  nvm_installer="${TMPDIR:-/tmp}/nvm-install-$NVM_VERSION.sh"
  run curl -fsSL -o "$nvm_installer" "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh"
  run bash "$nvm_installer"
  if [ "$DRY_RUN" = 0 ]; then
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
  fi
  run nvm install "$NODE_MAJOR"
fi

# A system Node often has a root-owned global prefix: install into ~/.local instead.
if [ "$DRY_RUN" = 0 ] && command -v npm >/dev/null 2>&1; then
  prefix="$(npm config get prefix)"
  if [ ! -w "$prefix" ]; then
    say "npm's global folder $prefix is not writable; using ~/.local"
    export NPM_CONFIG_PREFIX="$HOME/.local"
    export PATH="$HOME/.local/bin:$PATH"
  fi
fi

say "installing @prestyj/cli@$CLI_VERSION"
run npm install -g "@prestyj/cli@$CLI_VERSION"

say "configuring this machine as a fleet node"
run ezcoder node init "${INIT_ARGS[@]+"${INIT_ARGS[@]}"}"

if [ "$SERVICE" = 1 ]; then
  if [ -d /run/systemd/system ] || [ "$DRY_RUN" = 1 ]; then
    say "installing the login service"
    run ezcoder node install
    run systemctl --user daemon-reload
    run systemctl --user enable --now ezcoder-node
    say "to keep it running while you are logged out: sudo loginctl enable-linger $(id -un)"
  else
    say "systemd is not running, so no login service was installed"
    say "on WSL2 add  [boot] systemd=true  to /etc/wsl.conf, run 'wsl --shutdown' from Windows, then: ezcoder node install"
    say "or start the node yourself: ezcoder node serve"
  fi
fi

say "done. Check it with: ezcoder node doctor"
