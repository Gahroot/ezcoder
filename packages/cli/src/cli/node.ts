// `ezcoder node …`: turn this machine into an EZCODER fleet node the main
// machine can send jobs, services and agents to (over Tailscale).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  defaultNodeDataDir,
  detectTailscale,
  initNodeConfig,
  isWildcardBind,
  listSecretNames,
  normalizeLabels,
  pairingString,
  readNodeConfig,
  removeSecret,
  setSecret,
} from "../core/fleet/node/config.js";
import { detectPlatform } from "../core/fleet/node/info.js";
import { startNodeServer } from "../core/fleet/node/server.js";
import type { NodeInfo } from "../core/fleet/protocol.js";

const HELP = `ezcoder node — run this machine as an EZCODER fleet node

  init [--name N] [--labels a,b] [--slots n] [--port P]   create the node config, print the pairing string
  serve [--bind IP] [--insecure-bind] [--port P]          serve the fleet API (Tailscale IP by default)
  status                                                  config, and live jobs/services when serving
  pair                                                    print the pairing string again
  secret set NAME | list | rm NAME                         deploy secrets (value read from stdin)
  install                                                 run 'node serve' at login (systemd --user / launchd)

  --data-dir DIR   node data folder (default ~/.ezcoder/node)`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value`);
  args.splice(i, 2);
  return v;
}

function bool(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

function intFlag(args: string[], name: string): number | undefined {
  const v = flag(args, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

const out = (s: string) => process.stdout.write(s + "\n");

function requireConfig(dataDir: string) {
  const cfg = readNodeConfig(dataDir);
  if (!cfg) throw new Error("this machine is not a fleet node yet: run `ezcoder node init` first");
  return cfg;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    process.stderr.write("value (then Enter, Ctrl-D): ");
  }
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
}

/** The command a service manager runs: this node + this CLI entry. */
function serveCommand(dataDir: string): string[] {
  const entry = fs.realpathSync(process.argv[1] ?? "ezcoder");
  const cmd = [process.execPath, entry, "node", "serve"];
  if (dataDir !== defaultNodeDataDir()) cmd.push("--data-dir", dataDir);
  return cmd;
}

export function systemdUnit(cmd: string[], pathEnv = process.env.PATH ?? ""): string {
  const quote = (s: string) => (/[\s"\\]/.test(s) ? `"${s.replace(/(["\\])/g, "\\$1")}"` : s);
  return `[Unit]
Description=EZCODER fleet node
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${cmd.map(quote).join(" ")}
Restart=always
RestartSec=10
Environment=PATH=${pathEnv}
# Jobs run detached and survive restarts of this service.
KillMode=process

[Install]
WantedBy=default.target
`;
}

export function launchdPlist(
  cmd: string[],
  logFile: string,
  pathEnv = process.env.PATH ?? "",
): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.ezcoder.node</string>
  <key>ProgramArguments</key>
  <array>
${cmd.map((c) => `    <string>${esc(c)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${esc(pathEnv)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>${esc(logFile)}</string>
  <key>StandardErrorPath</key><string>${esc(logFile)}</string>
</dict>
</plist>
`;
}

/** Windows Startup-folder script that keeps the WSL distro (and so the node) running. */
export function wslStartupVbs(distro: string): string {
  return `CreateObject("WScript.Shell").Run "wsl.exe -d ${distro} --exec /bin/sh -c ""sleep infinity""", 0, False`;
}

async function cmdInit(args: string[], dataDir: string): Promise<void> {
  const name = flag(args, "--name");
  const labelsRaw = flag(args, "--labels");
  const slots = intFlag(args, "--slots");
  const port = intFlag(args, "--port");
  const bind = flag(args, "--bind");
  const cfg = await initNodeConfig({
    dataDir,
    name,
    labels: labelsRaw !== undefined ? normalizeLabels(labelsRaw.split(",")) : undefined,
    slots,
    port,
    bind,
  });
  const ts = await detectTailscale();
  out(`Fleet node "${cfg.name}" configured in ${dataDir}`);
  out(`  slots ${cfg.slots} · labels ${cfg.labels.join(",") || "-"} · port ${cfg.port}`);
  if (!ts.running) {
    out("  ! Tailscale is not running here. Install/start it (https://tailscale.com/download),");
    out("    then run `ezcoder node init` again so the pairing string has the tailnet address.");
  }
  out("");
  out("Pair it from your main machine:");
  out(`  ezcoder fleet add '${pairingString(cfg)}'`);
  out("");
  out("Then start it: ezcoder node serve   (or `ezcoder node install` to run it at login)");
}

async function cmdServe(args: string[], dataDir: string): Promise<void> {
  const cfg = requireConfig(dataDir);
  const bindFlag = flag(args, "--bind");
  const insecure = bool(args, "--insecure-bind");
  const port = intFlag(args, "--port");
  if (port) cfg.port = port;
  let bind = bindFlag ?? cfg.bind;
  if (!bind) {
    const ts = await detectTailscale();
    if (!ts.running || !ts.ip) {
      throw new Error(
        "Tailscale is not running, so there is no private address to listen on. " +
          "Start Tailscale (`sudo tailscale up`), or pass --bind <ip> explicitly.",
      );
    }
    bind = ts.ip;
    if (!cfg.advertiseHost || cfg.advertiseHost === os.hostname())
      cfg.advertiseHost = ts.dnsName ?? ts.ip;
  }
  if (isWildcardBind(bind) && !(bindFlag && insecure)) {
    throw new Error(
      `refusing to listen on every interface (${bind}). The node runs commands for anyone with ` +
        "its token; keep it on the tailnet. If you really mean it: --bind 0.0.0.0 --insecure-bind",
    );
  }
  cfg.bind = bind;
  if (!cfg.advertiseHost) cfg.advertiseHost = bind;
  const server = await startNodeServer({ config: cfg });
  out(`EZCODER node "${cfg.name}" serving on ${server.url} (data ${dataDir})`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    out("stopping (running jobs keep going and are re-adopted on the next start)…");
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise<never>(() => {});
}

async function cmdStatus(dataDir: string): Promise<void> {
  const cfg = requireConfig(dataDir);
  out(`node      ${cfg.name}`);
  out(`data      ${dataDir}`);
  out(
    `address   ${cfg.advertiseHost}:${cfg.port}${cfg.bind ? ` (bind ${cfg.bind})` : " (bind: Tailscale IP)"}`,
  );
  out(`labels    ${cfg.labels.join(",") || "-"}`);
  out(`slots     ${cfg.slots}`);
  out(`secrets   ${listSecretNames(dataDir).join(", ") || "-"}`);
  let host = cfg.bind;
  if (!host) host = (await detectTailscale()).ip ?? "127.0.0.1";
  if (isWildcardBind(host)) host = "127.0.0.1";
  try {
    const res = await fetch(
      `http://${host.includes(":") ? `[${host}]` : host}:${cfg.port}/v1/info`,
      {
        headers: { authorization: `Bearer ${cfg.token}` },
        signal: AbortSignal.timeout(3000),
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = (await res.json()) as NodeInfo;
    out(`serving   yes (${info.platform}, v${info.version})`);
    out(
      `machine   ${info.cpus} cpu · ${info.memoryFreeGb}/${info.memoryGb} GB free · load ${info.load} · disk ${info.diskFreeGb} GB free`,
    );
    out(`gpus      ${info.gpus.map((g) => `${g.name} (${g.memoryGb} GB)`).join(", ") || "-"}`);
    out(`docker    ${info.docker ? "yes" : "no"} · model auth ${info.modelAuth ? "yes" : "no"}`);
    out(`slots     ${info.slotsUsed}/${info.slots} used`);
    for (const j of info.jobs.filter((x) => x.state === "running" || x.state === "preparing")) {
      out(`  job ${j.id} ${j.kind} ${j.state} (${j.project})`);
    }
    for (const s of info.services)
      out(`  service ${s.id} ${s.kind} ${s.state} ${s.endpoints.map((e) => e.url).join(" ")}`);
  } catch {
    out("serving   no (start it with `ezcoder node serve`)");
  }
}

async function cmdSecret(args: string[], dataDir: string): Promise<void> {
  requireConfig(dataDir);
  const action = args.shift();
  const name = args.shift();
  if (action === "list") {
    const names = listSecretNames(dataDir);
    out(names.length ? names.join("\n") : "(no secrets)");
    return;
  }
  if (action === "set" && name) {
    const value = await readStdin();
    if (!value)
      throw new Error(
        'empty value: pipe it in, e.g. `printf %s "$TOKEN" | ezcoder node secret set NAME`',
      );
    setSecret(dataDir, name, value);
    out(`secret ${name} saved (only jobs on nodes labelled 'deploy' can use it)`);
    return;
  }
  if (action === "rm" && name) {
    out(removeSecret(dataDir, name) ? `secret ${name} removed` : `no secret named ${name}`);
    return;
  }
  throw new Error("usage: ezcoder node secret set NAME | list | rm NAME");
}

function cmdInstall(dataDir: string): void {
  requireConfig(dataDir);
  const platform = detectPlatform();
  const cmd = serveCommand(dataDir);
  if (platform === "macos") {
    const plist = path.join(os.homedir(), "Library", "LaunchAgents", "dev.ezcoder.node.plist");
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, launchdPlist(cmd, path.join(dataDir, "node.log")));
    out(`wrote ${plist}`);
    out("enable it with:");
    out(`  launchctl bootstrap gui/$(id -u) ${plist}`);
    return;
  }
  if (platform === "windows") {
    throw new Error("run the node inside WSL2 on Windows (see the fleet-nodes docs)");
  }
  if (!fs.existsSync("/run/systemd/system")) {
    out("systemd is not running here, so there is no user service manager to install into.");
    if (platform === "wsl2") {
      out(
        "Enable it in /etc/wsl.conf:  [boot]\\nsystemd=true  then `wsl --shutdown` from Windows.",
      );
    }
    out(`Otherwise start it yourself: ${cmd.join(" ")}`);
    return;
  }
  const unitDir = path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
    "systemd",
    "user",
  );
  const unit = path.join(unitDir, "ezcoder-node.service");
  fs.mkdirSync(unitDir, { recursive: true });
  fs.writeFileSync(unit, systemdUnit(cmd));
  out(`wrote ${unit}`);
  out("enable it with:");
  out("  systemctl --user daemon-reload && systemctl --user enable --now ezcoder-node");
  out("keep it running when you are logged out:");
  out(`  sudo loginctl enable-linger ${os.userInfo().username}`);
  if (platform === "wsl2") {
    const distro = process.env.WSL_DISTRO_NAME ?? "Ubuntu";
    out("");
    out(
      "WSL2 stops when no Windows program uses it. To keep it (and the node) running from login,",
    );
    out(
      "save this one line as ezcoder-node.vbs in your Windows Startup folder (Win+R → shell:startup):",
    );
    out(`  ${wslStartupVbs(distro)}`);
  }
}

export async function runNode(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = [...argv];
  const dataDir = path.resolve(flag(args, "--data-dir") ?? defaultNodeDataDir());
  const action = args.shift();
  switch (action) {
    case "init":
      return cmdInit(args, dataDir);
    case "serve":
      return cmdServe(args, dataDir);
    case "status":
      return cmdStatus(dataDir);
    case "pair":
      out(pairingString(requireConfig(dataDir)));
      return;
    case "secret":
      return cmdSecret(args, dataDir);
    case "install":
      return cmdInstall(dataDir);
    case undefined:
    case "help":
      out(HELP);
      return;
    default:
      throw new Error(`unknown node command: ${action}\n\n${HELP}`);
  }
}
