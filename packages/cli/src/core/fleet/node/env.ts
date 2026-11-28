// X6: what a host-shell job or remote agent inherits from the node process.
// An allow-list, not a block-list: anything not named here (cloud keys,
// tokens, agent sockets, loader hooks) never reaches controller-sent code.

const ALLOWED_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LANGUAGE",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SHELL",
  "TZ",
  "XDG_RUNTIME_DIR",
  // The docker CLI on the host needs to find its daemon; containers only get `-e` names.
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  // Windows equivalents (WSL interop, tests).
  "SYSTEMROOT",
  "SystemRoot",
  "COMSPEC",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PATHEXT",
]);

/** Names of node env vars a child may inherit. LC_* is allowed as a family. */
export function isAllowedInheritedEnv(name: string): boolean {
  return ALLOWED_NAMES.has(name) || /^LC_[A-Z_]+$/.test(name);
}

/**
 * The inherited part of a child's environment: allow-listed names from `env`
 * plus the `extra` EZ_* names the caller explicitly needs.
 */
export function allowedBaseEnv(
  env: NodeJS.ProcessEnv = process.env,
  extra: readonly string[] = [],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (isAllowedInheritedEnv(k) || extra.includes(k)) out[k] = v;
  }
  return out;
}
