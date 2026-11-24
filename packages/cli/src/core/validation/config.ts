// Project validation config: `.ezcoder/validation.json` when present, otherwise
// detected from the project's files so most projects need no setup at all.
import fs from "node:fs";
import path from "node:path";
import type { DockerSpec, ProjectValidationConfig, StageConfig } from "./types.js";

export const VALIDATION_CONFIG_FILE = path.join(".ezcoder", "validation.json");

const DEFAULT_LOCAL_TIMEOUT = 15;
const DEFAULT_REMOTE_TIMEOUT = 60;
const STAGE_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/** Single-quote a string for POSIX sh. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Per-project cache key for workers: the repo name, limited to [A-Za-z0-9._-]. */
export function cacheKeyFor(repo: string | undefined): string {
  const name = (repo ?? "").split("/").pop() ?? "";
  const key = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._-]+/, "");
  return key.slice(0, 100) || "default";
}

/** Package-manager caches pointed into the per-project cache mounted at /cache. */
export const IMAGE_CACHE_ENV: Readonly<Record<string, string>> = {
  npm_config_cache: "/cache/npm",
  npm_config_store_dir: "/cache/pnpm-store",
  YARN_CACHE_FOLDER: "/cache/yarn",
  PIP_CACHE_DIR: "/cache/pip",
  BUNDLE_PATH: "/cache/bundle",
  GOMODCACHE: "/cache/go/mod",
  GOCACHE: "/cache/go/build",
  CARGO_HOME: "/cache/cargo",
};

/**
 * The shell command a worker runs for a stage: setup, then the command (in Docker if asked).
 * Image-mode stages mount the worker's per-project cache (`$EZ_CACHE`, else the default
 * directory for `cacheKey`) at /cache.
 */
export function buildStageCommand(stage: StageConfig, cacheKey = "default"): string {
  let cmd = stage.command;
  const d: DockerSpec | undefined = stage.run === "remote" ? stage.docker : undefined;
  if (d?.compose && d.service) {
    const f = shQuote(d.compose);
    const ep = d.entrypoint !== undefined ? ` --entrypoint ${shQuote(d.entrypoint)}` : "";
    cmd =
      `docker compose -f ${f} build ${shQuote(d.service)} && ` +
      `docker compose -f ${f} run --rm${ep} ${shQuote(d.service)} sh -c ${shQuote(stage.command)}`;
  } else if (d?.image) {
    const cache = `"\${EZ_CACHE:-$HOME/.cache/ezcoder-worker/${cacheKeyFor(cacheKey)}}"`;
    const env = Object.entries(IMAGE_CACHE_ENV)
      .map(([k, v]) => ` -e ${k}=${v}`)
      .join("");
    cmd =
      `mkdir -p ${cache} && docker run --rm -v "$PWD":/w -v ${cache}:/cache -w /w${env} ` +
      `${shQuote(d.image)} sh -c ${shQuote(stage.command)}`;
  }
  return stage.setup ? `${stage.setup} && ${cmd}` : cmd;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function exists(cwd: string, rel: string): boolean {
  return fs.existsSync(path.join(cwd, rel));
}

const COMPOSE_TEST_FILES = [
  "docker-compose.test.yml",
  "docker-compose-test.yml",
  "docker-compose.test.yaml",
  "compose.test.yml",
  "compose.test.yaml",
];

/** Detect sensible stages from the files a project already has. */
export function detectStages(cwd: string): { stages: StageConfig[]; notes: string[] } {
  const stages: StageConfig[] = [];
  const notes: string[] = [];
  const remote = (name: string, command: string, docker?: DockerSpec): StageConfig => ({
    name,
    command,
    run: "remote",
    required: true,
    timeoutMinutes: DEFAULT_REMOTE_TIMEOUT,
    ...(docker ? { docker } : {}),
  });

  // A compose test file with a `tests` service is the most faithful environment.
  for (const f of COMPOSE_TEST_FILES) {
    if (!exists(cwd, f)) continue;
    const text = fs.readFileSync(path.join(cwd, f), "utf8");
    if (/^\s{2}tests:\s*$/m.test(text)) {
      stages.push(
        remote(
          "test",
          `docker compose -f ${shQuote(f)} up --build --abort-on-container-exit --exit-code-from tests`,
        ),
      );
      notes.push(`test: runs the "tests" service of ${f}.`);
    } else {
      notes.push(`${f} has no "tests" service; add stages to ${VALIDATION_CONFIG_FILE} to use it.`);
    }
    break;
  }

  const pkg = readJson(path.join(cwd, "package.json")) as
    { scripts?: Record<string, string> } | undefined;
  if (pkg) {
    const scripts = pkg.scripts ?? {};
    const pm = exists(cwd, "pnpm-lock.yaml")
      ? "pnpm"
      : exists(cwd, "yarn.lock")
        ? "yarn"
        : exists(cwd, "bun.lockb") || exists(cwd, "bun.lock")
          ? "bun"
          : "npm";
    const runScript = (s: string) => (pm === "npm" ? `npm run ${s}` : `${pm} ${s}`);
    const quick = ["typecheck", "check", "lint"].find((s) => scripts[s]);
    if (quick) {
      stages.push({
        name: quick,
        command: runScript(quick),
        run: "local",
        required: false,
        timeoutMinutes: DEFAULT_LOCAL_TIMEOUT,
      });
      notes.push(`${quick}: quick local feedback from package.json.`);
    }
    const test = scripts.test;
    if (test && !/no test specified/.test(test) && !stages.some((s) => s.name === "test")) {
      const install =
        pm === "pnpm"
          ? "corepack enable && pnpm install --frozen-lockfile"
          : pm === "yarn"
            ? "corepack enable && yarn install --frozen-lockfile"
            : pm === "bun"
              ? "npm i -g bun && bun install --minimum-release-age=172800 --frozen-lockfile"
              : exists(cwd, "package-lock.json")
                ? "npm ci"
                : "npm install";
      stages.push(remote("test", `${install} && ${runScript("test")}`, { image: "node:22" }));
      notes.push(`test: ${pm} test in node:22 on a worker.`);
    }
  }

  if (!stages.some((s) => s.name === "test")) {
    if (exists(cwd, "Gemfile") && exists(cwd, "spec")) {
      stages.push(remote("test", "bundle install && bundle exec rspec", { image: "ruby:3.3" }));
      notes.push("test: rspec in ruby:3.3 (apps that need a database want a compose stage).");
    } else if (exists(cwd, "go.mod")) {
      stages.push(remote("test", "go test ./...", { image: "golang:1.23" }));
      notes.push("test: go test in golang:1.23.");
    } else if (exists(cwd, "Cargo.toml")) {
      stages.push(remote("test", "cargo test", { image: "rust:1" }));
      notes.push("test: cargo test in rust:1.");
    } else if (exists(cwd, "pyproject.toml") || exists(cwd, "requirements.txt")) {
      const install = exists(cwd, "requirements.txt")
        ? "pip install -q -r requirements.txt pytest"
        : "pip install -q -e . pytest";
      stages.push(remote("test", `${install} && python -m pytest -q`, { image: "python:3.12" }));
      notes.push("test: pytest in python:3.12.");
    }
  }
  if (stages.length === 0) {
    notes.push(`No test setup detected; add stages to ${VALIDATION_CONFIG_FILE}.`);
  }
  return { stages, notes };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Turn one raw stage from the config file into a full stage, or explain why not. */
export function parseStage(raw: unknown, detected: StageConfig[]): StageConfig | string {
  if (!raw || typeof raw !== "object") return "each stage must be an object";
  const r = raw as Record<string, unknown>;
  const name = str(r.name);
  if (!name || !STAGE_NAME.test(name))
    return `stage name "${String(r.name)}" must be lowercase letters, digits, . _ -`;
  const base = detected.find((s) => s.name === name);
  const command = str(r.command) ?? base?.command;
  if (!command) return `stage "${name}" needs a command`;
  const run: "local" | "remote" =
    r.run === "local" || r.run === "remote" ? r.run : (base?.run ?? "remote");
  const docker = (r.docker && typeof r.docker === "object" ? r.docker : base?.docker) as
    DockerSpec | undefined;
  const resources =
    r.resources && typeof r.resources === "object"
      ? (r.resources as StageConfig["resources"])
      : undefined;
  return {
    name,
    command,
    run,
    required: typeof r.required === "boolean" ? r.required : run === "remote",
    timeoutMinutes:
      num(r.timeoutMinutes) ?? (run === "local" ? DEFAULT_LOCAL_TIMEOUT : DEFAULT_REMOTE_TIMEOUT),
    ...(str(r.setup) ? { setup: str(r.setup) } : {}),
    ...(docker ? { docker } : {}),
    ...(resources ? { resources } : {}),
    ...(str(r.backend) ? { backend: str(r.backend) } : {}),
  };
}

/**
 * Load a project's config. The file may list only the stages it wants to
 * change; `"extendDefaults": true` keeps the detected stages it doesn't name.
 */
export function loadProjectConfig(cwd: string): ProjectValidationConfig | { error: string } {
  const detected = detectStages(cwd);
  const file = path.join(cwd, VALIDATION_CONFIG_FILE);
  const base = {
    statusContextPrefix: "ezcoder",
    cancelSuperseded: true,
    postCommitStatus: true,
  };
  if (!fs.existsSync(file)) {
    return { ...base, stages: detected.stages, source: "auto", notes: detected.notes };
  }
  const raw = readJson(file);
  if (!raw || typeof raw !== "object")
    return { error: `${VALIDATION_CONFIG_FILE} is not valid JSON` };
  const r = raw as Record<string, unknown>;
  const stages: StageConfig[] = [];
  for (const s of Array.isArray(r.stages) ? r.stages : []) {
    const parsed = parseStage(s, detected.stages);
    if (typeof parsed === "string") return { error: `${VALIDATION_CONFIG_FILE}: ${parsed}` };
    if (stages.some((x) => x.name === parsed.name)) {
      return { error: `${VALIDATION_CONFIG_FILE}: stage "${parsed.name}" is listed twice` };
    }
    stages.push(parsed);
  }
  if (r.extendDefaults === true) {
    for (const s of detected.stages) if (!stages.some((x) => x.name === s.name)) stages.push(s);
  }
  return {
    repo: str(r.repo),
    stages,
    statusContextPrefix: str(r.statusContextPrefix) ?? base.statusContextPrefix,
    cancelSuperseded:
      typeof r.cancelSuperseded === "boolean" ? r.cancelSuperseded : base.cancelSuperseded,
    postCommitStatus:
      typeof r.postCommitStatus === "boolean" ? r.postCommitStatus : base.postCommitStatus,
    source: "file",
    notes: r.extendDefaults === true ? detected.notes : [],
  };
}

/** owner/name from a GitHub remote URL (https or ssh); undefined for other hosts. */
export function parseGitHubRepo(url: string): string | undefined {
  const m = url.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : undefined;
}
