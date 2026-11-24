// `ezcoder validate …`: the async validation orchestrator from a shell, plus
// the background daemon that keeps jobs moving when no EZCODER app is open.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readBackendsFile, writeBackendsFile } from "../core/validation/backends.js";
import { detectStages, VALIDATION_CONFIG_FILE } from "../core/validation/config.js";
import {
  describeJob,
  describeWorker,
  short,
  ValidationService,
} from "../core/validation/service.js";
import { isTerminal } from "../core/validation/types.js";

const HELP = `ezcoder validate — asynchronous validation against exact commits

  run [stage…] [--ref R] [--force] [--wait]   queue stages for HEAD (or R); returns at once
  status                                     stages, running and recent jobs for this project
  gate [--ref R] [--wait]                    exit 0 only if every required stage passed at the commit
  logs <id> [--full]                         failing (or whole) log of a job
  cancel <id> | retry <id>
  workers                                    each machine: online, platform, slots, cpu/mem, load
  init                                       write ${VALIDATION_CONFIG_FILE} from detected defaults
  add-worker <id> --repo owner/name [--workflow remote-test.yml] [--max N]
             [--labels a,b] [--cpus N] [--memory-gb N]
             [--discover]                   pool: machines come from runner labels (ezw-…)
             [--cloud] [--cloud-runs-on ubuntu-latest] [--cloud-max N]
             [--cloud-when overflow|always] (GitHub-hosted runners; cost Actions minutes)
  remove-worker <id>
  daemon                                     keep jobs moving until none are left (started for you)`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

function bool(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

/** Start the daemon in the background unless some EZCODER process already leads. */
export async function ensureValidationDaemon(svc: ValidationService): Promise<boolean> {
  if (await svc.leaderAlive()) return false;
  const entry = process.argv[1];
  if (!entry) return false;
  const child = spawn(process.execPath, [entry, "validate", "daemon"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  return true;
}

async function waitFor(svc: ValidationService, ids: string[]): Promise<void> {
  svc.start({ keepAlive: true });
  for (;;) {
    const jobs = (await svc.store.read()).filter((j) => ids.includes(j.id));
    if (jobs.every((j) => isTerminal(j.state))) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  svc.stop();
}

export async function runValidate(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = [...argv];
  const action = args.shift();
  const cwd = process.cwd();
  const svc = ValidationService.shared();
  // This process exits in a moment: let a session host or the daemon lead.
  svc.autoStart = false;
  const out = (s: string) => process.stdout.write(s + "\n");

  switch (action) {
    case "run": {
      const ref = flag(args, "--ref");
      const force = bool(args, "--force");
      const wait = bool(args, "--wait");
      const r = await svc.enqueue(cwd, {
        ...(args.length ? { stages: args } : {}),
        ...(ref ? { ref } : {}),
        force,
      });
      out(`Commit ${short(r.sha)}${r.branch ? ` (${r.branch})` : ""}`);
      for (const j of r.jobs) out(`  queued ${j.id} ${j.stage}`);
      for (const j of r.reused) out(`  ${describeJob(j)}`);
      for (const m of r.messages) out(`  ${m}`);
      if (wait) {
        await waitFor(
          svc,
          [...r.jobs, ...r.reused].map((j) => j.id),
        );
        const done = (await svc.store.read()).filter(
          (j) => r.jobs.some((x) => x.id === j.id) || r.reused.some((x) => x.id === j.id),
        );
        for (const j of done) out(`  ${describeJob(j)}`);
        if (done.some((j) => j.state !== "passed")) process.exitCode = 1;
      } else if (r.jobs.length && (await ensureValidationDaemon(svc))) {
        out("  (background daemon started)");
      }
      return;
    }
    case "status": {
      const cfg = svc.config(cwd);
      if ("error" in cfg) out(`Config error: ${cfg.error}`);
      else {
        out(`Stages (${cfg.source === "file" ? VALIDATION_CONFIG_FILE : "auto-detected"}):`);
        for (const s of cfg.stages) {
          out(
            `  ${s.name} [${s.run}${s.required ? ", required" : ""}, ${s.timeoutMinutes}m]: ${s.command}`,
          );
        }
        for (const n of cfg.notes) out(`  note: ${n}`);
      }
      const jobs = await svc.list(cwd);
      const shown = [
        ...jobs.filter((j) => !isTerminal(j.state)),
        ...jobs.filter((j) => isTerminal(j.state)).slice(-10),
      ];
      out(shown.length ? "Jobs:" : "No jobs yet.");
      for (const j of shown) out(`  ${describeJob(j)}`);
      return;
    }
    case "gate": {
      const ref = flag(args, "--ref");
      if (bool(args, "--wait")) {
        const g0 = await svc.gate(cwd, ref);
        const pending = g0.rows
          .filter((r) => r.jobId && !isTerminal(r.state as never))
          .map((r) => r.jobId!);
        if (pending.length) await waitFor(svc, pending);
      }
      const g = await svc.gate(cwd, ref);
      out(`${g.ok ? "PASS" : "NOT READY"} at ${short(g.sha)}`);
      for (const r of g.rows)
        out(`  ${r.stage}: ${r.state}${r.note ? ` (${r.note})` : ""}${r.url ? ` ${r.url}` : ""}`);
      if (!g.ok) process.exitCode = 1;
      return;
    }
    case "logs": {
      const id = args.find((a) => !a.startsWith("--"));
      if (!id) throw new Error("usage: ezcoder validate logs <id> [--full]");
      out(await svc.logs(id, !args.includes("--full")));
      return;
    }
    case "cancel": {
      const j = args[0] ? await svc.cancel(args[0]) : undefined;
      out(j ? describeJob(j) : "No such job.");
      return;
    }
    case "retry": {
      if (!args[0]) throw new Error("usage: ezcoder validate retry <id>");
      const j = await svc.retry(args[0]);
      out(`Queued ${j.id}`);
      await ensureValidationDaemon(svc);
      return;
    }
    case "workers": {
      for (const w of await svc.workers()) out(describeWorker(w));
      for (const p of svc.problems) out(`config problem: ${p}`);
      return;
    }
    case "init": {
      const file = path.join(cwd, VALIDATION_CONFIG_FILE);
      if (fs.existsSync(file)) throw new Error(`${VALIDATION_CONFIG_FILE} already exists`);
      const { stages, notes } = detectStages(cwd);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ stages }, null, 2) + "\n");
      out(`Wrote ${VALIDATION_CONFIG_FILE} with ${stages.length} stage(s).`);
      for (const n of notes) out(`  ${n}`);
      return;
    }
    case "add-worker": {
      const id = args.shift();
      const repo = flag(args, "--repo");
      if (!id || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
        throw new Error("usage: ezcoder validate add-worker <id> --repo owner/name [...]");
      }
      if (id === "local") throw new Error('"local" is reserved');
      const labels = flag(args, "--labels");
      const cpus = flag(args, "--cpus");
      const mem = flag(args, "--memory-gb");
      const discover = bool(args, "--discover");
      const cloudOn = bool(args, "--cloud");
      const cloudRunsOn = flag(args, "--cloud-runs-on");
      const cloudMax = flag(args, "--cloud-max");
      const cloudWhen = flag(args, "--cloud-when");
      if (cloudWhen && cloudWhen !== "overflow" && cloudWhen !== "always") {
        throw new Error("--cloud-when must be overflow or always");
      }
      if ((cloudOn || cloudRunsOn || cloudMax || cloudWhen) && !discover) {
        throw new Error("cloud options need --discover (cloud overflow belongs to a pool)");
      }
      const file = readBackendsFile(svc.dir);
      const backends = (file.backends ?? []).filter((b) => b.id !== id);
      backends.push({
        id,
        kind: "github-actions",
        repo,
        workflow: flag(args, "--workflow") ?? "remote-test.yml",
        maxConcurrent: Number(flag(args, "--max") ?? 1),
        ...(labels ? { labels: labels.split(",").map((l) => l.trim()) } : {}),
        ...(cpus || mem
          ? {
              capacity: {
                ...(cpus ? { cpus: Number(cpus) } : {}),
                ...(mem ? { memoryGb: Number(mem) } : {}),
              },
            }
          : {}),
        ...(discover ? { discover: true } : {}),
        ...(cloudOn || cloudRunsOn || cloudMax || cloudWhen
          ? {
              cloud: {
                enabled: cloudOn,
                runsOn: (cloudRunsOn ?? "ubuntu-latest").split(",").map((l) => l.trim()),
                maxConcurrent: Number(cloudMax ?? 2),
                when: (cloudWhen ?? "overflow") as "overflow" | "always",
              },
            }
          : {}),
      });
      writeBackendsFile(svc.dir, { ...file, backends });
      out(
        `Worker ${id} saved${discover ? " as a pool (machines come from its runner labels)" : ""}. ` +
          "Every project can use it now.",
      );
      return;
    }
    case "remove-worker": {
      const file = readBackendsFile(svc.dir);
      writeBackendsFile(svc.dir, {
        ...file,
        backends: (file.backends ?? []).filter((b) => b.id !== args[0]),
      });
      out(`Removed ${args[0]}.`);
      return;
    }
    case "daemon": {
      svc.start({ keepAlive: true });
      let idle = 0;
      for (;;) {
        await new Promise((r) => setTimeout(r, 20_000));
        const active = (await svc.store.read()).some((j) => !isTerminal(j.state));
        idle = active ? 0 : idle + 1;
        if (idle >= 3) break;
      }
      svc.stop();
      return;
    }
    default:
      out(HELP);
      if (action && action !== "help") process.exitCode = 1;
  }
}
