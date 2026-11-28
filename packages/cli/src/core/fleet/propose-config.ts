// A7: propose a `.ezcoder/fleet.json` from what the project contains
// (package.json scripts, Dockerfile, Playwright config), for the user to
// approve once. Writing it is a separate, approved step (fleet tool apply_config).
import fs from "node:fs";
import path from "node:path";
import {
  detectFleetDefaults,
  FLEET_CONFIG_FILE,
  parseFleetDefaults,
  type FleetJobSpec,
  type FleetPlacement,
} from "./project-config.js";

/** The on-disk shape of one job in fleet.json. */
export interface ProposedJob {
  kind: FleetJobSpec["kind"];
  command: string;
  docker?: FleetJobSpec["docker"];
  artifacts?: string[];
  timeoutMinutes?: number;
}

export interface ProposedFleetConfig {
  jobs: Record<string, ProposedJob>;
  defaults: Record<string, FleetPlacement>;
}

export interface FleetConfigProposal {
  config: ProposedFleetConfig;
  /** One line per detected thing, plain words. */
  reasons: string[];
  /** fleet.json already exists (applying replaces it). */
  exists: boolean;
  file: string;
}

const LONG_SCRIPT = /^(test|test:unit|test:all|e2e|test:e2e|lint|typecheck|check)$/;

function toProposed(spec: FleetJobSpec): ProposedJob {
  return {
    kind: spec.kind,
    command: spec.command,
    ...(spec.docker ? { docker: spec.docker } : {}),
    ...(spec.artifacts ? { artifacts: spec.artifacts } : {}),
    timeoutMinutes: spec.timeoutMinutes,
  };
}

export function proposeFleetConfig(cwd: string): FleetConfigProposal {
  const detected = detectFleetDefaults(cwd);
  const jobs: Record<string, ProposedJob> = {};
  const defaults: Record<string, FleetPlacement> = {};
  const reasons: string[] = [];
  for (const [name, spec] of Object.entries(detected.jobs)) jobs[name] = toProposed(spec);
  reasons.push(...detected.notes.filter((n) => !/^dev:|^No build/.test(n)));

  let pkg: { scripts?: Record<string, string> } | undefined;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")) as typeof pkg;
  } catch {
    pkg = undefined;
  }
  const build = detected.jobs.build;
  // Reuse the install step the build job worked out (pnpm/yarn/npm ci ...).
  const install = build?.command.split(" && ").slice(0, -1).join(" && ") || "npm install";
  const runner = build?.command.match(/&& (pnpm|yarn|bun|npm run) [^&]*$/)?.[1] ?? "npm run";
  const run = runner === "npm run" ? "npm run" : `${runner} run`;
  for (const script of Object.keys(pkg?.scripts ?? {})) {
    if (!LONG_SCRIPT.test(script) || jobs[script.replace(/:/g, "-")]) continue;
    const name = script.replace(/:/g, "-");
    if (name === "e2e" && jobs.e2e) continue;
    jobs[name] = {
      kind: "test",
      command: `${install} && ${run} ${script}`,
      docker: { image: "node:22" },
      timeoutMinutes: 60,
    };
    reasons.push(`${name}: the package.json "${script}" script.`);
  }
  if (fs.existsSync(path.join(cwd, "Dockerfile")) && !jobs.image) {
    jobs.image = {
      kind: "build",
      command: "docker build -t ezf-image .",
      timeoutMinutes: 60,
    };
    reasons.push("image: a Dockerfile at the root (builds on a node with docker).");
  }
  if (jobs.e2e) defaults.e2e = "fleet";
  for (const n of ["test", "test-all", "test-e2e"]) if (jobs[n]) defaults[n] = "fleet";
  if (Object.keys(defaults).length) {
    reasons.push(
      `defaults: ${Object.keys(defaults).join(", ")} run on the fleet unless asked otherwise.`,
    );
  }
  const file = path.join(cwd, FLEET_CONFIG_FILE);
  return { config: { jobs, defaults }, reasons, exists: fs.existsSync(file), file };
}

/** Check a config (proposed or edited by the agent) before writing it. */
export function validateProposedConfig(v: unknown): ProposedFleetConfig {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("config must be an object");
  const c = v as Record<string, unknown>;
  const jobs = (c.jobs ?? {}) as Record<string, unknown>;
  if (typeof jobs !== "object" || Array.isArray(jobs)) throw new Error(`"jobs" must be an object`);
  for (const [name, j] of Object.entries(jobs)) {
    const cmd = (j as { command?: unknown } | null)?.command;
    if (typeof cmd !== "string" || !cmd.trim()) throw new Error(`jobs.${name}.command is required`);
  }
  const defaults = c.defaults !== undefined ? parseFleetDefaults(c.defaults) : {};
  return { ...(c as object), jobs, defaults } as ProposedFleetConfig;
}

/** Write fleet.json (atomically). Only after the user approved it. */
export function writeFleetConfig(cwd: string, config: ProposedFleetConfig): string {
  const file = path.join(cwd, FLEET_CONFIG_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
  fs.renameSync(tmp, file);
  return file;
}
