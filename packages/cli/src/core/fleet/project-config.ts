// Project fleet config: `.ezcoder/fleet.json` when present, merged over defaults
// detected from the project's files. `browser` and `llm` services are always
// available as built-ins, so adding a machine never requires changing projects.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DockerSpec, JobKind, PortSpec, Resources, ServiceKind } from "./protocol.js";

export const FLEET_CONFIG_FILE = path.join(".ezcoder", "fleet.json");

export interface FleetJobSpec {
  name: string;
  kind: JobKind;
  command: string;
  docker?: DockerSpec;
  env?: Record<string, string>;
  /** Node-local secret names (deploy-labelled nodes only). */
  secrets?: string[];
  resources?: Resources;
  artifacts?: string[];
  timeoutMinutes: number;
  /** Sub-folder of the repo to run in. */
  subdir?: string;
  /** deploy only: false skips the validation gate for this job. */
  gate?: boolean;
  cacheKey?: string;
}

export interface FleetServiceSpec {
  name: string;
  kind: ServiceKind;
  docker: DockerSpec;
  command?: string;
  env?: Record<string, string>;
  ports: PortSpec[];
  resources?: Resources;
  persist?: string;
  idleStopMinutes?: number;
  /** Clone the project into the service workspace (devenvs, Dockerfile builds). */
  needsSource: boolean;
}

export interface FleetProjectConfig {
  jobs: Record<string, FleetJobSpec>;
  services: Record<string, FleetServiceSpec>;
  source: "file" | "auto";
  notes: string[];
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const SECRET = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const JOB_KINDS: readonly JobKind[] = [
  "validate",
  "build",
  "test",
  "browser",
  "render",
  "deploy",
  "custom",
];
const SERVICE_KINDS: readonly ServiceKind[] = ["inference", "browser", "devenv", "custom"];
const DEFAULT_TIMEOUT: Record<JobKind, number> = {
  validate: 60,
  build: 60,
  test: 60,
  browser: 60,
  render: 120,
  deploy: 30,
  custom: 60,
};
const FALLBACK_PLAYWRIGHT = "1.65.0";

function exists(cwd: string, rel: string): boolean {
  return fs.existsSync(path.join(cwd, rel));
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** JSON with // and /* comments and trailing commas (devcontainer.json). */
function readJsonc(file: string): unknown {
  try {
    const text = fs
      .readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'])\/\/.*$/gm, "$1")
      .replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Playwright version this CLI uses; a remote run-server must match it for connect(). */
export function localPlaywrightVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req("playwright/package.json") as { version?: string };
    if (pkg.version && /^\d+\.\d+\.\d+$/.test(pkg.version)) return pkg.version;
  } catch {
    // optional dependency missing
  }
  return FALLBACK_PLAYWRIGHT;
}

function playwrightImage(version: string): string {
  return `mcr.microsoft.com/playwright:v${version}-noble`;
}

/** Built-in services every project has. */
export function builtinServices(): Record<string, FleetServiceSpec> {
  const pw = localPlaywrightVersion();
  return {
    llm: {
      name: "llm",
      kind: "inference",
      docker: { image: "ollama/ollama", gpu: true },
      ports: [{ container: 11434, name: "openai", protocol: "http" }],
      persist: "ollama",
      resources: { gpus: 1 },
      needsSource: false,
    },
    browser: {
      name: "browser",
      kind: "browser",
      docker: { image: playwrightImage(pw) },
      command: `npx -y playwright@${pw} run-server --port 3000 --host 0.0.0.0`,
      ports: [{ container: 3000, name: "playwright", protocol: "ws" }],
      needsSource: false,
    },
  };
}

function languageImage(cwd: string): string {
  if (exists(cwd, "package.json")) return "node:22";
  if (exists(cwd, "pyproject.toml") || exists(cwd, "requirements.txt")) return "python:3.12";
  if (exists(cwd, "go.mod")) return "golang:1.23";
  if (exists(cwd, "Cargo.toml")) return "rust:1";
  if (exists(cwd, "Gemfile")) return "ruby:3.3";
  return "ubuntu:24.04";
}

/** Defaults detected from the project's files. */
export function detectFleetDefaults(cwd: string): {
  jobs: Record<string, FleetJobSpec>;
  services: Record<string, FleetServiceSpec>;
  notes: string[];
} {
  const jobs: Record<string, FleetJobSpec> = {};
  const notes: string[] = [];
  const pkg = readJson(path.join(cwd, "package.json")) as
    | {
        scripts?: Record<string, string>;
        devDependencies?: Record<string, string>;
        dependencies?: Record<string, string>;
      }
    | undefined;

  if (pkg) {
    const pm = exists(cwd, "pnpm-lock.yaml")
      ? "pnpm"
      : exists(cwd, "yarn.lock")
        ? "yarn"
        : exists(cwd, "bun.lockb") || exists(cwd, "bun.lock")
          ? "bun"
          : "npm";
    const install =
      pm === "pnpm"
        ? "corepack enable && pnpm install --frozen-lockfile"
        : pm === "yarn"
          ? "corepack enable && yarn install --frozen-lockfile"
          : pm === "bun"
            ? "npm i -g bun && bun install"
            : exists(cwd, "package-lock.json")
              ? "npm ci"
              : "npm install";
    if (pkg.scripts?.build) {
      jobs.build = {
        name: "build",
        kind: "build",
        command: `${install} && ${pm === "npm" ? "npm run build" : `${pm} run build`}`,
        docker: { image: "node:22" },
        artifacts: ["dist/**"],
        timeoutMinutes: DEFAULT_TIMEOUT.build,
      };
      notes.push(`build: the package.json build script (${pm}).`);
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const pwConfig = ["ts", "js", "mjs", "cjs", "mts"].find((e) =>
      exists(cwd, `playwright.config.${e}`),
    );
    if (pwConfig) {
      const declared = (deps["@playwright/test"] ?? deps.playwright ?? "").match(/\d+\.\d+\.\d+/);
      const version = declared?.[0] ?? localPlaywrightVersion();
      jobs.e2e = {
        name: "e2e",
        kind: "browser",
        command: `${install} && npx playwright test`,
        docker: { image: playwrightImage(version) },
        artifacts: ["playwright-report/**", "test-results/**"],
        timeoutMinutes: DEFAULT_TIMEOUT.browser,
      };
      notes.push(`e2e: playwright.config.${pwConfig} found (image v${version}).`);
    }
  }
  if (!jobs.build && exists(cwd, "Cargo.toml")) {
    jobs.build = {
      name: "build",
      kind: "build",
      command: "cargo build --release",
      docker: { image: "rust:1" },
      timeoutMinutes: DEFAULT_TIMEOUT.build,
    };
    notes.push("build: cargo build --release.");
  }
  if (!jobs.build && exists(cwd, "go.mod")) {
    jobs.build = {
      name: "build",
      kind: "build",
      command: "go build ./...",
      docker: { image: "golang:1.23" },
      timeoutMinutes: DEFAULT_TIMEOUT.build,
    };
    notes.push("build: go build ./....");
  }
  if (!jobs.build && (exists(cwd, "Makefile") || exists(cwd, "makefile"))) {
    jobs.build = {
      name: "build",
      kind: "build",
      command: "make",
      docker: { image: "buildpack-deps:bookworm" },
      timeoutMinutes: DEFAULT_TIMEOUT.build,
    };
    notes.push("build: make.");
  }
  if (!jobs.build) notes.push(`No build detected; add jobs to ${FLEET_CONFIG_FILE}.`);

  // Dev environment: devcontainer image/Dockerfile, a root Dockerfile, else a language image.
  let devDocker: DockerSpec;
  const dc = readJsonc(path.join(cwd, ".devcontainer", "devcontainer.json")) as
    { image?: string; dockerFile?: string; build?: { dockerfile?: string } } | undefined;
  const dcFile = dc?.build?.dockerfile ?? dc?.dockerFile;
  if (dc?.image) {
    devDocker = { image: dc.image };
    notes.push("dev: image from .devcontainer/devcontainer.json.");
  } else if (dcFile) {
    devDocker = { dockerfile: path.posix.join(".devcontainer", dcFile) };
    notes.push("dev: Dockerfile from .devcontainer/devcontainer.json.");
  } else if (exists(cwd, "Dockerfile")) {
    devDocker = { dockerfile: "Dockerfile" };
    notes.push("dev: the project's Dockerfile.");
  } else {
    devDocker = { image: languageImage(cwd) };
  }
  const services: Record<string, FleetServiceSpec> = {
    ...builtinServices(),
    dev: {
      name: "dev",
      kind: "devenv",
      docker: devDocker,
      command: "sleep infinity",
      ports: [],
      needsSource: true,
    },
  };
  return { jobs, services, notes };
}

// ── validation of the file ────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function strArray(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x)) {
    throw new Error(`${what} must be an array of non-empty strings`);
  }
  return v as string[];
}

function strRecord(v: unknown, what: string): Record<string, string> {
  if (!isObj(v) || Object.values(v).some((x) => typeof x !== "string")) {
    throw new Error(`${what} must be an object of strings`);
  }
  return v as Record<string, string>;
}

function num(v: unknown, what: string, min = 0): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min) {
    throw new Error(`${what} must be a number >= ${min}`);
  }
  return v;
}

function parseDocker(v: unknown, what: string): DockerSpec {
  if (!isObj(v)) throw new Error(`${what} must be an object`);
  const d: DockerSpec = {};
  for (const k of ["image", "dockerfile", "compose", "service", "entrypoint"] as const) {
    if (v[k] === undefined) continue;
    if (typeof v[k] !== "string") throw new Error(`${what}.${k} must be a string`);
    d[k] = v[k];
  }
  if (v.gpu !== undefined) {
    if (typeof v.gpu !== "boolean") throw new Error(`${what}.gpu must be true or false`);
    d.gpu = v.gpu;
  }
  if (v.args !== undefined) d.args = strArray(v.args, `${what}.args`);
  if (!d.image && !d.dockerfile && !d.compose) {
    throw new Error(`${what} needs "image", "dockerfile" or "compose"`);
  }
  if (d.compose && !d.service) throw new Error(`${what}: "compose" needs "service"`);
  return d;
}

function parseResources(v: unknown, what: string): Resources {
  if (!isObj(v)) throw new Error(`${what} must be an object`);
  const r: Resources = {};
  if (v.cpus !== undefined) r.cpus = num(v.cpus, `${what}.cpus`);
  if (v.memoryGb !== undefined) r.memoryGb = num(v.memoryGb, `${what}.memoryGb`);
  if (v.gpus !== undefined) r.gpus = num(v.gpus, `${what}.gpus`);
  if (v.gpuMemoryGb !== undefined) r.gpuMemoryGb = num(v.gpuMemoryGb, `${what}.gpuMemoryGb`);
  if (v.labels !== undefined) r.labels = strArray(v.labels, `${what}.labels`);
  return r;
}

function parseJob(name: string, v: unknown, base: FleetJobSpec | undefined): FleetJobSpec {
  const what = `jobs.${name}`;
  if (!NAME.test(name)) throw new Error(`${what}: names use a-z, 0-9, ".", "_" or "-"`);
  if (!isObj(v)) throw new Error(`${what} must be an object`);
  const kind = (v.kind ?? base?.kind ?? "custom") as JobKind;
  if (!JOB_KINDS.includes(kind)) {
    throw new Error(`${what}.kind must be one of ${JOB_KINDS.join(", ")}`);
  }
  const command = v.command ?? base?.command;
  if (typeof command !== "string" || !command.trim())
    throw new Error(`${what}.command is required`);
  const job: FleetJobSpec = {
    name,
    kind,
    command,
    timeoutMinutes:
      v.timeoutMinutes !== undefined
        ? num(v.timeoutMinutes, `${what}.timeoutMinutes`, 1)
        : (base?.timeoutMinutes ?? DEFAULT_TIMEOUT[kind]),
  };
  const docker = v.docker !== undefined ? parseDocker(v.docker, `${what}.docker`) : base?.docker;
  if (docker) job.docker = docker;
  if (v.env !== undefined) job.env = strRecord(v.env, `${what}.env`);
  if (v.secrets !== undefined) {
    job.secrets = strArray(v.secrets, `${what}.secrets`);
    const bad = job.secrets.find((s) => !SECRET.test(s));
    if (bad) throw new Error(`${what}.secrets: "${bad}" is not a valid secret name`);
  }
  const res =
    v.resources !== undefined ? parseResources(v.resources, `${what}.resources`) : base?.resources;
  if (res) job.resources = res;
  const artifacts =
    v.artifacts !== undefined ? strArray(v.artifacts, `${what}.artifacts`) : base?.artifacts;
  if (artifacts) job.artifacts = artifacts;
  if (v.subdir !== undefined) {
    if (typeof v.subdir !== "string" || v.subdir.split(/[\\/]/).includes("..")) {
      throw new Error(`${what}.subdir must be a relative path inside the repo`);
    }
    job.subdir = v.subdir;
  }
  if (v.gate !== undefined) {
    if (typeof v.gate !== "boolean") throw new Error(`${what}.gate must be true or false`);
    job.gate = v.gate;
  }
  if (v.cacheKey !== undefined) {
    if (typeof v.cacheKey !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(v.cacheKey)) {
      throw new Error(`${what}.cacheKey must use A-Z, a-z, 0-9, ".", "_" or "-"`);
    }
    job.cacheKey = v.cacheKey;
  }
  return job;
}

function parsePorts(v: unknown, what: string): PortSpec[] {
  if (!Array.isArray(v)) throw new Error(`${what} must be an array`);
  return v.map((p, i) => {
    if (!isObj(p)) throw new Error(`${what}[${i}] must be an object`);
    const container = num(p.container, `${what}[${i}].container`, 1);
    if (!Number.isInteger(container) || container > 65_535) {
      throw new Error(`${what}[${i}].container must be a port number`);
    }
    if (typeof p.name !== "string" || !p.name) throw new Error(`${what}[${i}].name is required`);
    const out: PortSpec = { container, name: p.name };
    if (p.protocol !== undefined) {
      if (p.protocol !== "http" && p.protocol !== "ws" && p.protocol !== "tcp") {
        throw new Error(`${what}[${i}].protocol must be http, ws or tcp`);
      }
      out.protocol = p.protocol;
    }
    return out;
  });
}

function parseService(
  name: string,
  v: unknown,
  base: FleetServiceSpec | undefined,
): FleetServiceSpec {
  const what = `services.${name}`;
  if (!NAME.test(name)) throw new Error(`${what}: names use a-z, 0-9, ".", "_" or "-"`);
  if (!isObj(v)) throw new Error(`${what} must be an object`);
  const kind = (v.kind ?? base?.kind ?? "custom") as ServiceKind;
  if (!SERVICE_KINDS.includes(kind)) {
    throw new Error(`${what}.kind must be one of ${SERVICE_KINDS.join(", ")}`);
  }
  const docker = v.docker !== undefined ? parseDocker(v.docker, `${what}.docker`) : base?.docker;
  if (!docker) throw new Error(`${what}.docker is required`);
  const svc: FleetServiceSpec = {
    name,
    kind,
    docker,
    ports: v.ports !== undefined ? parsePorts(v.ports, `${what}.ports`) : (base?.ports ?? []),
    needsSource: kind === "devenv" || !!docker.dockerfile || !!docker.compose,
  };
  const command = v.command ?? base?.command ?? (kind === "devenv" ? "sleep infinity" : undefined);
  if (command !== undefined) {
    if (typeof command !== "string") throw new Error(`${what}.command must be a string`);
    svc.command = command;
  }
  if (v.env !== undefined) svc.env = strRecord(v.env, `${what}.env`);
  const res =
    v.resources !== undefined ? parseResources(v.resources, `${what}.resources`) : base?.resources;
  if (res) svc.resources = res;
  const persist = v.persist ?? base?.persist;
  if (persist !== undefined) {
    if (typeof persist !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(persist)) {
      throw new Error(`${what}.persist must be a volume name`);
    }
    svc.persist = persist;
  }
  if (v.idleStopMinutes !== undefined) {
    svc.idleStopMinutes = num(v.idleStopMinutes, `${what}.idleStopMinutes`);
  }
  return svc;
}

/** The project's jobs and services: the file over the detected defaults. */
export function loadFleetConfig(cwd: string): FleetProjectConfig | { error: string } {
  const detected = detectFleetDefaults(cwd);
  const file = path.join(cwd, FLEET_CONFIG_FILE);
  if (!fs.existsSync(file)) {
    return {
      jobs: detected.jobs,
      services: detected.services,
      source: "auto",
      notes: detected.notes,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { error: `${FLEET_CONFIG_FILE} is not valid JSON: ${(e as Error).message}` };
  }
  try {
    if (!isObj(raw)) throw new Error("must be a JSON object");
    const jobs = { ...detected.jobs };
    const services = { ...detected.services };
    if (raw.jobs !== undefined) {
      if (!isObj(raw.jobs)) throw new Error(`"jobs" must be an object`);
      for (const [name, v] of Object.entries(raw.jobs))
        jobs[name] = parseJob(name, v, detected.jobs[name]);
    }
    if (raw.services !== undefined) {
      if (!isObj(raw.services)) throw new Error(`"services" must be an object`);
      for (const [name, v] of Object.entries(raw.services)) {
        const devBase = isObj(v) && v.kind === "devenv" ? detected.services.dev : undefined;
        services[name] = parseService(name, v, detected.services[name] ?? devBase);
      }
    }
    return { jobs, services, source: "file", notes: detected.notes };
  } catch (e) {
    return { error: `${FLEET_CONFIG_FILE}: ${(e as Error).message}` };
  }
}
