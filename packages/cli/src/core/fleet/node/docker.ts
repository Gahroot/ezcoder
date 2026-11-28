// Docker argument building and validation shared by jobs and services.
// Everything we create is named `ezf-<id>` and labelled `ezcoder.fleet=<id>`;
// cleanup only ever touches those labels.
import fs from "node:fs";
import path from "node:path";
import { IMAGE_CACHE_ENV } from "../../validation/config.js";
import type { DockerSpec, Resources } from "../protocol.js";

export const FLEET_LABEL = "ezcoder.fleet";
export const SERVICE_LABEL = "ezcoder.fleet.service";
export const VOLUME_LABEL = "ezcoder.fleet.volume";

export function containerName(id: string): string {
  return `ezf-${id}`.toLowerCase();
}

const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidImage(image: string): boolean {
  return IMAGE.test(image);
}

export function isValidEnvName(name: string): boolean {
  return ENV_NAME.test(name);
}

const HOST_NAMESPACE_FLAGS = new Set([
  "--network",
  "--net",
  "--pid",
  "--ipc",
  "--uts",
  "--userns",
  "--cgroupns",
]);
const SENSITIVE_HOST_PATHS = ["/var/run/docker.sock", "/run/docker.sock"];
/** The only folders under the node dataDir a container may mount (never the token, secrets or state). */
const MOUNTABLE_DATA_ENTRIES = new Set(["cache", "jobs", "services"]);
/** Host devices a container may get (GPUs, sound, video); block devices, memory etc. are refused. */
const ALLOWED_DEVICE =
  /^\/dev\/(dri(\/[A-Za-z0-9_-]+)?|nvidia[A-Za-z0-9_-]*|kfd|snd|video\d+)(:|$)/;
/** The only `docker run` flags a job or service may add. Anything else is refused. */
const BOOL_FLAGS = new Set(["--init", "--read-only", "--tty", "--interactive", "--no-healthcheck"]);
const VALUE_FLAGS = new Set([
  ...HOST_NAMESPACE_FLAGS,
  "--add-host",
  "--cap-drop",
  "--cpu-shares",
  "--cpus",
  "--cpuset-cpus",
  "--device",
  "--dns",
  "--env",
  "--expose",
  "--gpus",
  "--hostname",
  "--label",
  "--memory",
  "--memory-reservation",
  "--memory-swap",
  "--mount",
  "--network-alias",
  "--pids-limit",
  "--platform",
  "--publish",
  "--pull",
  "--runtime",
  "--security-opt",
  "--shm-size",
  "--stop-signal",
  "--stop-timeout",
  "--tmpfs",
  "--ulimit",
  "--user",
  "--volume",
  "--workdir",
]);
const SHORT_BOOL = new Set(["i", "t"]);
/** Short flags that take a value (pflag: `-vX`, `-v=X` or `-v X`). */
const SHORT_VALUE: Record<string, string> = {
  c: "--cpu-shares",
  e: "--env",
  h: "--hostname",
  l: "--label",
  m: "--memory",
  p: "--publish",
  u: "--user",
  v: "--volume",
  w: "--workdir",
};

/**
 * Validate user-supplied `docker run` args. Returns an error message, or
 * undefined when acceptable. Every token is parsed the way docker parses it
 * and only allow-listed flags pass, so a value can never hide a flag. Refuses
 * privilege escalation, host namespaces, capability grants, custom security
 * profiles and host-path mounts (only named volumes and the mountable folders
 * under `allowedRoot`).
 */
export function validateDockerArgs(
  args: string[] | undefined,
  allowedRoot?: MountScope,
): string | undefined {
  if (!args) return undefined;
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string"))
    return "docker.args must be strings";
  for (let i = 0; i < args.length; i++) {
    const raw = args[i]!;
    let flag = "";
    let value: string | undefined;
    if (raw.startsWith("--") && raw.length > 2) {
      const eq = raw.indexOf("=");
      flag = eq > 0 ? raw.slice(0, eq) : raw;
      if (BOOL_FLAGS.has(flag)) {
        if (eq > 0 && !/^(true|false)$/.test(raw.slice(eq + 1)))
          return `docker arg not allowed: ${raw}`;
        continue;
      }
      if (!VALUE_FLAGS.has(flag)) return `docker arg not allowed: ${flag}`;
      if (eq > 0) value = raw.slice(eq + 1);
    } else if (/^-[^-]/.test(raw)) {
      // Short flags, possibly bundled (`-itv/:/h`, `-v=/:/h`).
      for (let j = 1; j < raw.length && !flag; j++) {
        const ch = raw[j]!;
        if (SHORT_BOOL.has(ch)) continue;
        const long = SHORT_VALUE[ch];
        if (!long) return `docker arg not allowed: -${ch}`;
        flag = long;
        value = raw.slice(j + 1).replace(/^=/, "") || undefined;
      }
      if (!flag) continue;
    } else {
      // A bare word would be read as the image, pushing ours into the command.
      return `docker arg not allowed: ${raw}`;
    }
    if (value === undefined) {
      if (i + 1 >= args.length) return `docker arg ${flag} needs a value`;
      value = args[++i]!;
    }
    const err = checkFlagValue(flag, value, allowedRoot);
    if (err) return err;
  }
  return undefined;
}

function checkFlagValue(
  flag: string,
  value: string,
  allowedRoot: MountScope | undefined,
): string | undefined {
  const refused = `docker arg not allowed: ${flag} ${value}`;
  if (HOST_NAMESPACE_FLAGS.has(flag) && /^\s*(host|container:)/i.test(value)) return refused;
  // A custom seccomp/apparmor profile can be as open as "unconfined".
  if (flag === "--security-opt" && !/^no-new-privileges([:=]true)?$/i.test(value)) return refused;
  if (flag === "--device" && !ALLOWED_DEVICE.test(value)) return refused;
  if (flag === "--runtime" && !/^(nvidia|runc)$/.test(value)) return refused;
  if (flag === "--label" && value.startsWith(FLEET_LABEL)) return refused;
  if (flag === "--publish" && !/^127\.0\.0\.1:/.test(value)) {
    return `${refused} (publish on 127.0.0.1 only; services get ports on the node's address)`;
  }
  if (flag === "--volume") return checkMountSource(volumeSource(value), allowedRoot);
  if (flag === "--mount") {
    // docker parses --mount as CSV with case-insensitive keys and values.
    const spec = value.replace(/["']/g, "");
    if (/(?:^|,)\s*volume-opt\s*=/i.test(spec)) {
      return "docker arg not allowed: --mount volume-opt (use a plain named volume)";
    }
    const m = /(?:^|,)\s*(?:source|src)\s*=([^,]*)/i.exec(spec);
    if (/(?:^|,)\s*type\s*=\s*bind/i.test(spec) || (m && isHostPath(m[1]!.trim()))) {
      return checkMountSource(m?.[1]?.trim() || "/", allowedRoot);
    }
  }
  return undefined;
}

function isHostPath(source: string): boolean {
  return (
    source.startsWith("/") ||
    source.startsWith(".") ||
    source.startsWith("~") ||
    /^[A-Za-z]:[\\/]/.test(source)
  );
}

/** Host side of a `-v` spec; keeps a Windows drive (`C:\\x:/y`) together. */
function volumeSource(spec: string): string {
  const drive = /^[A-Za-z]:[\\/]/.test(spec) ? 2 : 0;
  const end = spec.indexOf(":", drive);
  return end < 0 ? spec : spec.slice(0, end);
}

/** Real path of `p`, resolving symlinks in the longest existing prefix. */
function realish(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Host folders a container may mount. A string is the node dataDir (only its
 * cache/jobs/services entries; used before a workspace exists). An array (X9)
 * is the exact set of folders: the job's own workspace and its cache.
 */
export type MountScope = string | readonly string[];

function insideReal(root: string, p: string): boolean {
  const rel = path.relative(realish(root), realish(p));
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function checkMountSource(source: string, allowedRoot: MountScope | undefined): string | undefined {
  if (!isHostPath(source)) return undefined; // named volume
  if (SENSITIVE_HOST_PATHS.includes(source)) return `docker mount not allowed: ${source}`;
  if (Array.isArray(allowedRoot)) {
    if (path.isAbsolute(source) && allowedRoot.some((r) => insideReal(r, source))) return undefined;
    return `docker host mount not allowed: ${source} (only this job's own workspace and cache can be mounted; use a named volume)`;
  }
  if (typeof allowedRoot === "string" && path.isAbsolute(source)) {
    // Docker follows symlinks on the host, so compare real paths.
    const rel = path.relative(realish(allowedRoot), realish(source));
    const first = rel.split(path.sep)[0] ?? "";
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel) && MOUNTABLE_DATA_ENTRIES.has(first))
      return undefined;
  }
  return `docker host mount not allowed: ${source} (use a named volume)`;
}

/** Check a DockerSpec before anything runs. */
export function validateDockerSpec(d: DockerSpec, allowedRoot?: MountScope): string | undefined {
  if (d.image !== undefined && !isValidImage(d.image)) return `invalid docker image: ${d.image}`;
  if (d.service !== undefined && !NAME.test(d.service))
    return `invalid compose service: ${d.service}`;
  if (
    d.entrypoint !== undefined &&
    (typeof d.entrypoint !== "string" || d.entrypoint.startsWith("-"))
  ) {
    return "invalid docker entrypoint";
  }
  for (const p of [d.dockerfile, d.compose]) {
    if (
      p !== undefined &&
      (typeof p !== "string" || path.isAbsolute(p) || p.split(/[\\/]/).includes(".."))
    ) {
      return `docker paths must stay inside the workspace: ${p}`;
    }
  }
  if (d.compose && !d.service) return "docker.compose needs docker.service";
  if (!d.image && !d.dockerfile && !d.compose) return "docker needs image, dockerfile or compose";
  return validateDockerArgs(d.args, allowedRoot);
}

export function resourceArgs(r: Resources | undefined): string[] {
  const out: string[] = [];
  if (r?.cpus && r.cpus > 0) out.push("--cpus", String(r.cpus));
  if (r?.memoryGb && r.memoryGb > 0) out.push("--memory", `${Math.round(r.memoryGb * 1024)}m`);
  return out;
}

/** `-e NAME` flags: values are passed via the docker CLI's environment, never argv. */
export function envFlags(names: Iterable<string>): string[] {
  const out: string[] = [];
  for (const n of names) if (isValidEnvName(n)) out.push("-e", n);
  return out;
}

/** Cache env inside containers (cache mounted at /cache). */
export function containerCacheEnv(): Record<string, string> {
  return { ...IMAGE_CACHE_ENV, EZ_CACHE: "/cache" };
}

/** Cache env for host-shell jobs. CARGO_HOME is left alone: it also holds the toolchain. */
export function hostCacheEnv(dir: string): Record<string, string> {
  const out: Record<string, string> = { EZ_CACHE: dir };
  for (const [k, v] of Object.entries(IMAGE_CACHE_ENV)) {
    if (k === "CARGO_HOME") continue;
    out[k] = path.join(dir, v.replace(/^\/cache\/?/, ""));
  }
  return out;
}
