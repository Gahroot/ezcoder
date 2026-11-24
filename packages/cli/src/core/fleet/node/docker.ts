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

const FORBIDDEN_FLAGS = new Set([
  "--privileged",
  "--name",
  "--rm",
  "--restart",
  "--volumes-from",
  "--cgroup-parent",
]);
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
/** Files/folders directly under the node dataDir a container must never see (token, secrets, state). */
const PRIVATE_DATA_ENTRIES = new Set(["node.json", "secrets.json", "state.json", "run", "tmp"]);
/** Host devices a container may get (GPUs, sound, video); block devices, memory etc. are refused. */
const ALLOWED_DEVICE =
  /^\/dev\/(dri(\/[A-Za-z0-9_-]+)?|nvidia[A-Za-z0-9_-]*|kfd|snd|video\d+)(:|$)/;
/** `docker run` short flags that take a value (pflag: `-vX`, `-v=X` or `-v X`). */
const SHORT_WITH_VALUE = new Set(["a", "c", "e", "h", "l", "m", "p", "u", "v", "w"]);

/**
 * Validate user-supplied `docker run` args. Returns an error message, or
 * undefined when acceptable. Refuses privilege escalation, host namespaces,
 * capability grants, unconfined security profiles and host-path mounts
 * (only named volumes and paths under `allowedRoot` may be mounted).
 */
export function validateDockerArgs(
  args: string[] | undefined,
  allowedRoot?: string,
): string | undefined {
  if (!args) return undefined;
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string"))
    return "docker.args must be strings";
  for (let i = 0; i < args.length; i++) {
    const raw = args[i]!;
    if (/^-[^-]/.test(raw)) {
      // Short flags, possibly bundled (`-itv/:/h`, `-v=/:/h`): find a volume value.
      for (let j = 1; j < raw.length; j++) {
        const ch = raw[j]!;
        if (!SHORT_WITH_VALUE.has(ch)) continue;
        const rest = raw.slice(j + 1).replace(/^=/, "");
        const v = rest || args[i + 1] || "";
        if (!rest) i++;
        if (ch === "v") {
          const err = checkMountSource(volumeSource(v), allowedRoot);
          if (err) return err;
        }
        break;
      }
      continue;
    }
    const eq = raw.indexOf("=");
    const flag = raw.startsWith("--") && eq > 0 ? raw.slice(0, eq) : raw;
    const inline = raw.startsWith("--") && eq > 0 ? raw.slice(eq + 1) : undefined;
    const value = () => inline ?? args[i + 1] ?? "";
    if (FORBIDDEN_FLAGS.has(flag)) return `docker arg not allowed: ${flag}`;
    if (HOST_NAMESPACE_FLAGS.has(flag) && /^\s*(host|container:)/i.test(value())) {
      return `docker arg not allowed: ${flag} ${value()}`;
    }
    if (flag === "--cap-add") return "docker arg not allowed: --cap-add";
    if (flag === "--device-cgroup-rule") return "docker arg not allowed: --device-cgroup-rule";
    if (
      flag === "--security-opt" &&
      /unconfined|no-new-privileges[:=]false|label[:=]disable/i.test(value())
    ) {
      return `docker arg not allowed: --security-opt ${value()}`;
    }
    if (flag === "--device" && !ALLOWED_DEVICE.test(value())) {
      return `docker arg not allowed: --device ${value()}`;
    }
    if (flag === "--volume") {
      const err = checkMountSource(volumeSource(value()), allowedRoot);
      if (err) return err;
    }
    if (flag === "--mount") {
      // docker parses --mount as CSV with case-insensitive keys and values.
      const spec = value().replace(/["']/g, "");
      if (/(?:^|,)\s*volume-opt\s*=/i.test(spec)) {
        return "docker arg not allowed: --mount volume-opt (use a plain named volume)";
      }
      const m = /(?:^|,)\s*(?:source|src)\s*=([^,]*)/i.exec(spec);
      if (/(?:^|,)\s*type\s*=\s*bind/i.test(spec) || (m && isHostPath(m[1]!.trim()))) {
        const err = checkMountSource(m?.[1]?.trim() || "/", allowedRoot);
        if (err) return err;
      }
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

function checkMountSource(source: string, allowedRoot: string | undefined): string | undefined {
  if (!isHostPath(source)) return undefined; // named volume
  if (SENSITIVE_HOST_PATHS.includes(source)) return `docker mount not allowed: ${source}`;
  if (allowedRoot && source.startsWith("/")) {
    // Docker follows symlinks on the host, so compare real paths.
    const rel = path.relative(realish(allowedRoot), realish(source));
    const first = rel.split(path.sep)[0] ?? "";
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel) && !PRIVATE_DATA_ENTRIES.has(first))
      return undefined;
  }
  return `docker host mount not allowed: ${source} (use a named volume)`;
}

/** Check a DockerSpec before anything runs. */
export function validateDockerSpec(d: DockerSpec, allowedRoot?: string): string | undefined {
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
