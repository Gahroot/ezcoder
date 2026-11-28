// `ezcoder fleet …`: the fleet controller from a shell, plus the background
// daemon that keeps fleet jobs moving when no EZCODER session is open.
import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import readline from "node:readline";
import { getAppPaths } from "@prestyj/core";
import { FleetClientError } from "../core/fleet/client.js";
import { discoverNodes } from "../core/fleet/discovery.js";
import {
  addMachine,
  fleetCapacity,
  listMachines,
  removeMachine,
  rotateMachineToken,
  shareableCredentials,
  shareAuth,
  type AddMachineOptions,
} from "../core/fleet/machines.js";
import { FLEET_CONFIG_FILE } from "../core/fleet/project-config.js";
import {
  describeFleetJob,
  describeFleetService,
  describeNode,
  FleetService,
  short,
} from "../core/fleet/service.js";
import { isFleetTerminal } from "../core/fleet/types.js";

const HELP = `ezcoder fleet — send jobs and services to your other machines (nodes)

  nodes                                   paired nodes (and cloud capacity): online, slots, cpu/mem, GPUs, labels
  discover                                find nodes on the tailnet (tailscale status)
  add [<pairing string>] [--offline] [--labels a,b]
                                          pair a node (string printed by \`ezcoder node init\`);
                                          no argument: read it from stdin or a hidden prompt
  add --code XXXX-XXXX [--host H]         pair with a short code from \`ezcoder node pair --code\`
  remove <node>
  rotate-token <node>                     give the node a new token (the old one stops working)
  update <node> [--version V] [--force]   update EZ Coder on the node and restart it
  run <job> [--node N|cloud] [--uncommitted] [--out DIR] [--wait]
                                          queue a job from ${FLEET_CONFIG_FILE} (or detected); returns at once
  status                                  jobs/services config and recent jobs for this project
  logs <id> | cancel <id>
  artifacts <id> [--out DIR]              download a job's artifacts
  service up <name> [--node N] | down <name|id> | list | log <name|id>
  dev up [--node N] [--committed] | exec <command…> | down
  share-auth <node> --yes [--force]       copy this machine's model credentials to the node
                                          (--force replaces credentials it already has)
  daemon                                  keep jobs moving until none are left (started for you)`;

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

/** Start `fleet daemon` in the background unless some EZCODER process already leads. */
export async function ensureFleetDaemon(svc: FleetService): Promise<boolean> {
  if (await svc.leaderAlive()) return false;
  const entry = process.argv[1];
  if (!entry) return false;
  const child = spawn(process.execPath, [entry, "fleet", "daemon"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  return true;
}

export { shareableCredentials };

/**
 * S5: the pairing string without putting it in shell history: all of stdin
 * when piped, else one line typed at a prompt that doesn't echo.
 */
export async function readPairingInput(
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Promise<string> {
  if (!input.isTTY) {
    let data = "";
    for await (const chunk of input) data += String(chunk);
    return data.trim();
  }
  output.write("Pairing string (input hidden): ");
  const muted = new Writable({ write: (_c, _e, cb) => cb() });
  const rl = readline.createInterface({ input, output: muted, terminal: true });
  try {
    const line = await new Promise<string>((resolve) => rl.once("line", resolve));
    return line.trim();
  } finally {
    rl.close();
    output.write("\n");
  }
}

export interface RunFleetDeps {
  svc?: FleetService;
  out?: (line: string) => void;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  /** Passed to addMachine (tests: discovery, client options). */
  add?: Pick<AddMachineOptions, "discover" | "client">;
}

export async function runFleet(
  argv: string[] = process.argv.slice(2),
  deps: RunFleetDeps = {},
): Promise<void> {
  const args = [...argv];
  const action = args.shift();
  const cwd = process.cwd();
  const svc = deps.svc ?? FleetService.shared();
  // This process exits in a moment: let a session host or the daemon lead.
  svc.autoStart = false;
  const out = deps.out ?? ((s: string) => process.stdout.write(s + "\n"));

  switch (action) {
    case "nodes": {
      const nodes = await svc.nodes();
      if (!nodes.length)
        out("No nodes paired. Run `ezcoder fleet discover`, then `ezcoder fleet add`.");
      for (const n of nodes) out(describeNode(n));
      const cap = fleetCapacity(await listMachines({ svc }), svc.localCapacity());
      out(
        `Capacity: ${cap.total} slots: this machine ${cap.local}, nodes ${cap.nodesUsed}/${cap.nodesTotal} used`,
      );
      for (const l of await svc.cloudLines(cwd).catch(() => [])) out(l);
      return;
    }
    case "discover": {
      const found = await discoverNodes();
      if (!found.length)
        out("No EZCODER nodes found on the tailnet (run `ezcoder node serve` there).");
      for (const f of found) {
        out(
          `${f.name} ${f.url} (${f.platform}, v${f.version})${f.paired ? " paired" : " NOT PAIRED — run `ezcoder node init` there and add its pairing string"}` +
            `${f.incompatible ? `; INCOMPATIBLE: ${f.incompatible}` : ""}`,
        );
      }
      return;
    }
    case "add": {
      const labels = flag(args, "--labels");
      const code = flag(args, "--code");
      const host = flag(args, "--host");
      const repo = flag(args, "--repo");
      const offline = bool(args, "--offline");
      const input =
        code ?? args[0] ?? (await readPairingInput(deps.stdin ?? process.stdin, process.stderr));
      if (!input) throw new Error("no pairing string given (usage: ezcoder fleet add <pairing>)");
      const r = await addMachine(input, {
        svc,
        offline,
        ...(host ? { host } : {}),
        ...(repo ? { repo } : {}),
        ...(labels ? { labels: labels.split(",").map((l) => l.trim()) } : {}),
        ...deps.add,
      });
      out(
        `Paired ${r.node.name} at ${r.node.url}${r.node.fingerprint ? " (TLS, certificate pinned)" : ""}` +
          `${r.verified ? "" : " without checking it (--offline)"}.`,
      );
      for (const c of r.doctor?.checks ?? []) {
        out(
          `  ${c.status.toUpperCase().padEnd(4)} ${c.id}: ${c.detail}${c.fix ? ` — fix: ${c.fix}` : ""}`,
        );
      }
      if (r.doctor && !r.doctor.ok)
        out("  Some checks failed; fix them on the node before sending work.");
      for (const w of r.warnings) out(`  note: ${w}`);
      return;
    }
    case "remove": {
      if (!args[0]) throw new Error("usage: ezcoder fleet remove <node>");
      out((await removeMachine(args[0], { svc })) ? `Removed ${args[0]}.` : `No node ${args[0]}.`);
      return;
    }
    case "rotate-token": {
      if (!args[0]) throw new Error("usage: ezcoder fleet rotate-token <node>");
      const r = await rotateMachineToken(args[0], { svc });
      out(
        `New token for ${args[0]} saved here; the old one no longer works.\n` +
          `Other machines that use ${args[0]} must pair again with:\n  ${r.pairing}`,
      );
      return;
    }
    case "update": {
      const version = flag(args, "--version");
      const force = bool(args, "--force");
      const name = args[0];
      if (!name) throw new Error("usage: ezcoder fleet update <node> [--version V] [--force]");
      const node = await svc.registry.get(name);
      if (!node) throw new Error(`no paired node "${name}"`);
      const r = await svc
        .client(node)
        .update({ ...(version ? { version } : {}), ...(force ? { force: true } : {}) });
      out(
        `${name}: updating EZ Coder ${r.from} -> ${r.to}${r.restarting ? "; it restarts when done" : ""}.`,
      );
      return;
    }
    case "run": {
      const node = flag(args, "--node");
      const outDir = flag(args, "--out");
      const uncommitted = bool(args, "--uncommitted");
      const wait = bool(args, "--wait");
      const name = args[0];
      if (!name) throw new Error("usage: ezcoder fleet run <job> [--node N] [--uncommitted]");
      const r = await svc.run(cwd, name, {
        ...(node ? { node } : {}),
        ...(outDir ? { outDir } : {}),
        ...(uncommitted ? { includeUncommitted: true } : {}),
      });
      out(
        `Queued ${r.job.id} ${r.job.name} at ${short(r.job.sha)}${r.job.hasPatch ? "+patch" : ""}`,
      );
      for (const m of r.messages) out(`  ${m}`);
      if (wait) {
        svc.start({ keepAlive: true });
        for (;;) {
          const j = await svc.get(r.job.id);
          if (!j || isFleetTerminal(j.state)) {
            if (j) out(describeFleetJob(j));
            if (j?.state !== "passed") process.exitCode = 1;
            break;
          }
          await new Promise((res) => setTimeout(res, 5000));
        }
        svc.stop();
      } else if (await ensureFleetDaemon(svc)) {
        out("  (background daemon started)");
      }
      return;
    }
    case "status": {
      const cfg = svc.config(cwd);
      if ("error" in cfg) out(`Config error: ${cfg.error}`);
      else {
        out(`Jobs (${cfg.source === "file" ? FLEET_CONFIG_FILE : "auto-detected"}):`);
        for (const j of Object.values(cfg.jobs)) out(`  ${j.name} [${j.kind}]: ${j.command}`);
        out(`Services: ${Object.keys(cfg.services).join(", ")}`);
        for (const n of cfg.notes) out(`  note: ${n}`);
      }
      const jobs = await svc.list(cwd);
      const shown = [
        ...jobs.filter((j) => !isFleetTerminal(j.state)),
        ...jobs.filter((j) => isFleetTerminal(j.state)).slice(-10),
      ];
      out(shown.length ? "Jobs:" : "No jobs yet.");
      for (const j of shown) out(`  ${describeFleetJob(j)}`);
      const services = (await svc.serviceList(cwd)).filter((s) => s.state !== "stopped");
      if (services.length) out("Services:");
      for (const s of services) out(`  ${describeFleetService(s)}`);
      return;
    }
    case "logs": {
      if (!args[0]) throw new Error("usage: ezcoder fleet logs <id>");
      out(await svc.logs(args[0], { full: true }));
      return;
    }
    case "cancel": {
      const j = args[0] ? await svc.cancel(args[0]) : undefined;
      out(j ? describeFleetJob(j) : "No such job.");
      return;
    }
    case "artifacts": {
      const dir = flag(args, "--out");
      if (!args[0]) throw new Error("usage: ezcoder fleet artifacts <id> [--out DIR]");
      const r = await svc.downloadArtifacts(args[0], dir);
      out(r.files.length ? `Downloaded ${r.files.length} file(s) to ${r.dir}` : "No artifacts.");
      return;
    }
    case "service": {
      const sub = args.shift();
      const node = flag(args, "--node");
      if (sub === "up") {
        if (!args[0]) throw new Error("usage: ezcoder fleet service up <name> [--node N]");
        const r = await svc.serviceUp(cwd, args[0], node ? { node } : {});
        out(`${r.reused ? "Already running" : "Started"}: ${describeFleetService(r.service)}`);
        for (const m of r.messages) out(`  ${m}`);
        if (!r.reused) await ensureFleetDaemon(svc);
      } else if (sub === "down") {
        if (!args[0]) throw new Error("usage: ezcoder fleet service down <name|id>");
        const s = await svc.serviceDown(args[0], cwd);
        out(`Stopped ${s.id} on ${s.node}.`);
      } else if (sub === "list") {
        const list = (await svc.serviceList()).filter((s) => s.state !== "stopped");
        if (!list.length) out("No fleet services running.");
        for (const s of list) out(describeFleetService(s));
      } else if (sub === "log") {
        if (!args[0]) throw new Error("usage: ezcoder fleet service log <name|id>");
        out(await svc.serviceLog(args[0], Number(flag(args, "--tail") ?? 200), cwd));
      } else {
        throw new Error("usage: ezcoder fleet service up|down|list|log …");
      }
      return;
    }
    case "dev": {
      const sub = args.shift();
      const node = flag(args, "--node");
      if (sub === "up") {
        const committed = bool(args, "--committed");
        const r = await svc.serviceUp(cwd, "dev", {
          ...(node ? { node } : {}),
          includeUncommitted: !committed,
        });
        out(`${r.reused ? "Already running" : "Started"}: ${describeFleetService(r.service)}`);
        for (const m of r.messages) out(`  ${m}`);
      } else if (sub === "exec") {
        if (!args.length) throw new Error("usage: ezcoder fleet dev exec <command…>");
        const r = await svc.serviceExec("dev", args.join(" "), { cwd });
        process.stdout.write(r.output.endsWith("\n") || !r.output ? r.output : `${r.output}\n`);
        process.exitCode = r.exitCode;
      } else if (sub === "down") {
        const s = await svc.serviceDown("dev", cwd);
        out(`Stopped ${s.id} on ${s.node}.`);
      } else {
        throw new Error("usage: ezcoder fleet dev up|exec|down");
      }
      return;
    }
    case "share-auth": {
      const yes = bool(args, "--yes");
      const name = args[0];
      const force = bool(args, "--force");
      if (!name) throw new Error("usage: ezcoder fleet share-auth <node> --yes [--force]");
      const node = await svc.registry.get(name);
      if (!node) throw new Error(`no paired node "${name}"`);
      const creds = shareableCredentials(getAppPaths().authFile);
      const providers = Object.keys(creds);
      if (!providers.length)
        throw new Error("no model credentials on this machine (ezcoder login first)");
      if (!yes) {
        out(
          `This copies your model credentials (${providers.join(", ")}) to ${name} (${node.url}) over the tailnet.\n` +
            "Anyone with access to that machine's account can then use them.\n" +
            "Subscription logins (OAuth) refresh themselves: if the node refreshes first, this machine may be signed out.\n" +
            "Safer: run `ezcoder login` on the node itself. Re-run with --yes to share anyway.",
        );
        process.exitCode = 1;
        return;
      }
      try {
        await shareAuth(name, { svc, ...(force ? { force: true } : {}) });
      } catch (e) {
        if (e instanceof FleetClientError && e.code === "exists") {
          out(
            `${name} already has its own model login, so nothing was changed.\n` +
              `To replace it with this machine's credentials, run: ezcoder fleet share-auth ${name} --yes --force`,
          );
          process.exitCode = 1;
          return;
        }
        throw e;
      }
      out(`Shared ${providers.length} credential(s) with ${name}.`);
      return;
    }
    case "daemon": {
      svc.start({ keepAlive: true });
      let idle = 0;
      for (;;) {
        await new Promise((r) => setTimeout(r, 20_000));
        const active = (await svc.jobs.read()).some((j) => !isFleetTerminal(j.state));
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
