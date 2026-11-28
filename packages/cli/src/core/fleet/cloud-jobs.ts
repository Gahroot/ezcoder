// Fleet jobs on cloud agent sandboxes (Claude Code cloud, Codex cloud) as
// extra capacity: which jobs may go there, how the job's command is wrapped,
// and how cloud placements are named. The sandbox's model only relays one
// exact command (core/cloud/runner.ts); a result counts only when the
// provider's harness recorded that command and its marker line.
import type { CloudSettings } from "../cloud/config.js";
import {
  CLOUD_PROVIDER_IDS,
  isCloudProviderId,
  type CloudAvailability,
  type CloudProviderId,
} from "../cloud/types.js";
import { VERIFIABLE_PROVIDERS } from "../validation/cloud-backend.js";
import type { DockerSpec, JobKind, Resources } from "./protocol.js";

/** `node` values that pin a job to cloud. */
export const CLOUD_PIN_ALIASES: readonly string[] = ["cloud", ...CLOUD_PROVIDER_IDS];

/** Published size of one cloud sandbox (Claude Code cloud: 4 vCPU, 16 GB). */
export const CLOUD_SANDBOX = { cpus: 4, memoryGb: 16 } as const;

/** Cheapest capable model for relaying one command (Claude). */
export const CLOUD_RUNNER_MODEL = "claude-haiku-5-5";
export const CLOUD_JOB_MAX_TURNS = 4;
export const CLOUD_JOB_DISALLOWED_TOOLS = [
  "Edit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Agent",
];

/**
 * Cloud sandboxes ship the docker CLI; the runner starts the daemon when none
 * runs (verified on Claude Code cloud: pulls, builds and services work).
 */
export const CLOUD_HAS_DOCKER = true;

/** Labels only self-hosted machines can satisfy. */
const NODE_ONLY_LABELS = new Set(["gpu", "windows", "macos", "deploy"]);

/**
 * Providers whose harness records the runner command's real output, so a job
 * result can be verified. Fleet jobs use only these (Codex's work log can't).
 */
export function cloudVerifiable(id: CloudProviderId): boolean {
  return VERIFIABLE_PROVIDERS.includes(id);
}

/** Why a cloud pin can't take jobs (undefined = it can). */
export function cloudPinProblem(pin: string): string | undefined {
  if (pin === "codex-cloud") return "Codex cloud can't report verified results; use claude-cloud";
  return undefined;
}

export function isCloudPin(node: string | undefined): boolean {
  return !!node && CLOUD_PIN_ALIASES.includes(node);
}

/** Placement name recorded on the job: "cloud:claude-cloud". */
export function cloudNodeName(id: CloudProviderId): string {
  return `cloud:${id}`;
}

export function cloudProviderOfNode(node: string | undefined): CloudProviderId | undefined {
  if (!node?.startsWith("cloud:")) return undefined;
  const id = node.slice("cloud:".length);
  return isCloudProviderId(id) ? id : undefined;
}

export interface CloudJobShape {
  kind: JobKind;
  secrets?: string[];
  resources?: Resources;
  docker?: DockerSpec;
  artifactGlobs?: string[];
  /** Uncommitted work goes as a node patch; cloud needs the local snapshot of it. */
  hasPatch?: boolean;
  snapshot?: string;
}

/** Why this job can't run in a cloud sandbox (undefined = it can). */
export function cloudIneligibility(
  job: CloudJobShape,
  opts: { pinned?: boolean } = {},
): string | undefined {
  if (job.kind === "deploy") return "deploys run only on your own machines";
  if (job.secrets?.length) return "it uses secrets, which never go to the cloud";
  const r = job.resources ?? {};
  if (r.gpus || r.gpuMemoryGb) return "it needs a GPU";
  const label = (r.labels ?? []).find((l) => NODE_ONLY_LABELS.has(l.toLowerCase()));
  if (label) return `it needs label "${label}"`;
  if (r.cpus && r.cpus > CLOUD_SANDBOX.cpus) return `it needs ${r.cpus} cpus (cloud has 4)`;
  if (r.memoryGb && r.memoryGb > CLOUD_SANDBOX.memoryGb) {
    return `it needs ${r.memoryGb} GB memory (cloud has 16)`;
  }
  const d = job.docker;
  if (d) {
    if (!CLOUD_HAS_DOCKER) return "cloud sandboxes have no running Docker daemon";
    if (d.compose) return "docker compose runs only on your own machines";
    if (d.gpu) return "it needs a GPU";
    if (d.args?.length || d.entrypoint)
      return "custom docker options run only on your own machines";
    if (!d.image && !d.dockerfile) return "its docker setup isn't a plain image or Dockerfile";
  }
  if (job.artifactGlobs?.length && !opts.pinned) {
    return "it declares artifacts, which cloud can't send back (pin it with node: cloud to run anyway)";
  }
  if (job.hasPatch && !job.snapshot) return "its uncommitted changes weren't captured for cloud";
  return undefined;
}

function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The job as one shell script for the sandbox, run from the repository root.
 * Plain env vars are exported; docker jobs mount the checkout at /work.
 */
export function cloudJobCommand(job: {
  id: string;
  command: string;
  subdir?: string;
  docker?: DockerSpec;
  env?: Record<string, string>;
}): string {
  const env = Object.entries(job.env ?? {}).filter(([k]) => ENV_NAME.test(k));
  const lines = env.map(([k, v]) => `export ${k}=${q(v)}`);
  const d = job.docker;
  if (!d) {
    lines.push(job.subdir ? `cd ${q(job.subdir)} && ${job.command}` : job.command);
    return lines.join("\n");
  }
  let image = d.image ?? "";
  if (d.dockerfile) {
    image = `ezf-cloud-${job.id.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}`;
    lines.push(`docker build -q -t ${image} -f ${q(d.dockerfile)} . >/dev/null || exit 125`);
  }
  const workdir = job.subdir ? `/work/${job.subdir.replace(/^\/+/, "")}` : "/work";
  const envFlags = env.map(([k]) => `-e ${k}`).join(" ");
  lines.push(
    `docker run --rm -v "$PWD":/work -w ${q(workdir)} ${envFlags ? `${envFlags} ` : ""}${q(image)} sh -c ${q(job.command)}`,
  );
  return lines.join("\n");
}

/** Job id safe for the runner marker and file names. */
export function cloudRunId(remoteId: string): string {
  return remoteId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "job";
}

/** One line per provider for `fleet nodes` / the fleet tool. */
export function describeCloudCapacity(
  a: CloudAvailability,
  settings: CloudSettings,
  active = 0,
): string {
  const when = settings.when ?? "overflow";
  const size = `${CLOUD_SANDBOX.cpus} cpu/${CLOUD_SANDBOX.memoryGb} GB`;
  if (!a.available) {
    return (
      `cloud: ${a.id} unavailable — ${a.detail}` +
      `${a.setupHint ? ` (${a.setupHint})` : ""}${active ? `; ${active} of our jobs` : ""}`
    );
  }
  if (!cloudVerifiable(a.id)) {
    return `cloud: ${a.id} connected; not used for jobs (can't report verified results)`;
  }
  return `cloud: ${a.id} ready, ${size}, ${when}${active ? `; ${active} of our jobs` : ""}`;
}
