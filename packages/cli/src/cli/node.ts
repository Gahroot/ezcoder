// `ezcoder node …`: turn this machine into an EZCODER fleet node the main
// machine can send jobs, services and agents to (over Tailscale).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuthStorage } from "@prestyj/core";
import qrcode from "qrcode-terminal";
import {
  configFingerprint,
  createPairCode,
  defaultNodeDataDir,
  detectTailscale,
  generateSelfSignedCert,
  initNodeConfig,
  isPrivateBind,
  isWildcardBind,
  normalizeLabels,
  pairingString,
  readNodeConfig,
  rotateNodeToken,
  writeNodeConfig,
} from "../core/fleet/node/config.js";
import type { NodeConfig } from "../core/fleet/node/context.js";
import { formatDoctorReport, runDoctor } from "../core/fleet/node/doctor.js";
import { DEFAULT_CACHE_CAP_GB, DEFAULT_GC_DAYS, startGcSweeper } from "../core/fleet/node/gc.js";
import { detectPlatform } from "../core/fleet/node/info.js";
import { isTerminalJob } from "../core/fleet/node/jobs.js";
import { localNodeFetch } from "../core/fleet/node/local-client.js";
import { startNodeServer } from "../core/fleet/node/server.js";
import { loadTlsFiles } from "../core/fleet/node/tls.js";
import { formatUninstall, loginServiceFile, uninstallNode } from "../core/fleet/node/uninstall.js";
import { installUpdate, runningUnderService, UpdateError } from "../core/fleet/node/update.js";
import {
  defaultSecretStore,
  NodeSecrets,
  unavailableStore,
  type SecretStore,
} from "../core/fleet/node/secrets.js";
import { sanitizeCacheKey } from "../core/fleet/node/workspace.js";
import type {
  ErrorResponse,
  NodeInfo,
  RotateTokenResponse,
  UpdateResponse,
} from "../core/fleet/protocol.js";

const HELP = `ezcoder node — run this machine as an EZCODER fleet node

  init [--name N] [--labels a,b] [--slots n] [--port P]   create the node config, print the pairing string
       [--tls | --tls-cert F --tls-key F]                 serve https (self-signed with --tls)
       [--docker-only]                                    only containerised work (saved in the config)
  serve [--bind IP] [--insecure-bind] [--port P]          serve the fleet API (Tailscale IP by default)
        [--tls-cert F --tls-key F] [--docker-only]        --docker-only: refuse host-shell jobs and agents
  status                                                  config, and live jobs/services when serving
  doctor [--repo URL]                                     check this machine is ready, with a fix per problem
  pair [--code]                                           print the pairing string (or a short code + QR)
  rotate-token                                            new token, new pairing string; the old one stops working
  config [--slots N] [--gc-days N] [--cache-cap-gb N]     show or change settings (a running node picks them up)
  secret set NAME | list | rm NAME                         deploy secrets (value read from stdin)
  install                                                 run 'node serve' at login (systemd --user / launchd)
  uninstall [--purge]                                     remove the login service (--purge: and the data folder)
  update [--version V] [--force]                          install another CLI version and restart

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

/** --tls-cert/--tls-key come together; both files are checked up front. */
function tlsFlags(args: string[]): Pick<NodeConfig, "tlsCert" | "tlsKey"> {
  const cert = flag(args, "--tls-cert");
  const key = flag(args, "--tls-key");
  if (!cert !== !key) throw new Error("TLS needs both files: pass --tls-cert FILE --tls-key FILE");
  if (!cert || !key) return {};
  const files = { tlsCert: path.resolve(cert), tlsKey: path.resolve(key) };
  loadTlsFiles(files.tlsCert, files.tlsKey);
  return files;
}

const pairingFor = (cfg: NodeConfig) => pairingString(cfg, configFingerprint(cfg));

async function cmdInit(args: string[], dataDir: string): Promise<void> {
  const name = flag(args, "--name");
  const labelsRaw = flag(args, "--labels");
  const slots = intFlag(args, "--slots");
  const port = intFlag(args, "--port");
  const bind = flag(args, "--bind");
  const advertiseHost = flag(args, "--host");
  const selfSigned = bool(args, "--tls");
  const dockerOnly = bool(args, "--docker-only");
  const files = tlsFlags(args);
  if (selfSigned && files.tlsCert) {
    throw new Error("use --tls (a self-signed certificate) or --tls-cert/--tls-key, not both");
  }
  let cfg = await initNodeConfig({
    dataDir,
    name,
    labels: labelsRaw !== undefined ? normalizeLabels(labelsRaw.split(",")) : undefined,
    slots,
    port,
    bind,
    advertiseHost,
    ...files,
    ...(dockerOnly && { dockerOnly: true }),
  });
  if (selfSigned && !(cfg.tlsCert && fs.existsSync(cfg.tlsCert))) {
    const made = await generateSelfSignedCert(dataDir, cfg.advertiseHost);
    cfg = { ...cfg, tlsCert: made.cert, tlsKey: made.key };
    writeNodeConfig(cfg);
  }
  const ts = await detectTailscale();
  out(`Fleet node "${cfg.name}" configured in ${dataDir}`);
  out(`  slots ${cfg.slots} · labels ${cfg.labels.join(",") || "-"} · port ${cfg.port}`);
  if (cfg.dockerOnly) out("  docker-only: host-shell jobs and remote agents are refused");
  if (cfg.tlsCert) out(`  https with ${cfg.tlsCert} (the pairing string pins its fingerprint)`);
  if (!ts.running && !cfg.tlsCert) {
    out("  ! Tailscale is not running here. Install/start it (https://tailscale.com/download),");
    out("    then run `ezcoder node init` again so the pairing string has the tailnet address.");
    out("    (Or serve https instead: `ezcoder node init --tls --host <address>`.)");
    // Without it the string would name a host off the tailnet, and the token would go there.
    return;
  }
  out("");
  out("Pair it from your main machine:");
  out(`  ezcoder fleet add '${pairingFor(cfg)}'`);
  out("");
  out("Then start it: ezcoder node serve   (or `ezcoder node install` to run it at login)");
}

interface StateJobLite {
  status?: { id?: string; state?: string; project?: string };
  cacheKey?: string;
}

/** Job records from <dataDir>/state.json (read-only; empty when missing or damaged). */
function stateJobs(dataDir: string): StateJobLite[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8")) as {
      jobs?: unknown;
    };
    return Array.isArray(raw.jobs) ? (raw.jobs as StateJobLite[]) : [];
  } catch {
    return [];
  }
}

const unfinished = (j: StateJobLite) =>
  !!j.status?.state && !isTerminalJob(j.status.state as Parameters<typeof isTerminalJob>[0]);

/** Cache folders in use by unfinished jobs (never trimmed by GC). */
function busyCacheKeys(dataDir: string, live: Array<{ project: string }>): Set<string> {
  const keys = new Set(live.map((j) => sanitizeCacheKey(j.project)));
  for (const j of stateJobs(dataDir).filter(unfinished)) {
    if (j.cacheKey) keys.add(j.cacheKey);
    if (j.status?.project) keys.add(sanitizeCacheKey(j.status.project));
  }
  return keys;
}

function liveConfig(dataDir: string): NodeConfig | undefined {
  try {
    return readNodeConfig(dataDir);
  } catch {
    return undefined;
  }
}

/**
 * `node serve` flags applied to the saved config, with the bind checks (X4/X5/X10).
 * Throws a plain-words error for an unsafe bind. Exported for tests.
 */
export async function resolveServeConfig(
  args: string[],
  cfg: NodeConfig,
  detect: typeof detectTailscale = detectTailscale,
): Promise<NodeConfig> {
  const bindFlag = flag(args, "--bind");
  const insecure = bool(args, "--insecure-bind");
  // X5: for this run only; `node init --docker-only` saves it in node.json.
  if (bool(args, "--docker-only")) cfg.dockerOnly = true;
  const port = intFlag(args, "--port");
  Object.assign(cfg, tlsFlags(args));
  const tlsOn = !!cfg.tlsCert;
  if (port) cfg.port = port;
  let bind = bindFlag ?? cfg.bind;
  const chosen = !!bind;
  if (!bind) {
    const ts = await detect();
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
  // With TLS (X10) the traffic is encrypted and the cert pinned, so any address is fine.
  if (chosen && !isPrivateBind(bind) && !insecure && !tlsOn) {
    throw new Error(
      `refusing to listen on ${bind}: it is not a Tailscale or loopback address, so the token, ` +
        "your code and any shared credentials would cross that network unencrypted. " +
        "Serve https instead (`ezcoder node init --tls`), or if you really mean it, add --insecure-bind",
    );
  }
  cfg.bind = bind;
  if (!cfg.advertiseHost) cfg.advertiseHost = bind;
  return cfg;
}

async function cmdServe(args: string[], dataDir: string): Promise<void> {
  const cfg = await resolveServeConfig(args, requireConfig(dataDir));
  const server = await startNodeServer({ config: cfg });
  out(`EZCODER node "${cfg.name}" serving on ${server.url} (data ${dataDir})`);
  // R5: clean up finished work while running; never anything still going.
  const gc = startGcSweeper({
    dataDir,
    gcDays: () => liveConfig(dataDir)?.gcDays,
    cacheCapGb: () => liveConfig(dataDir)?.cacheCapGb,
    jobBusy: (id) => {
      const j = server.jobs.get(id);
      if (j) return !isTerminalJob(j.state);
      return stateJobs(dataDir).some((r) => r.status?.id === id && unfinished(r));
    },
    cacheBusy: (name) =>
      busyCacheKeys(
        dataDir,
        server.jobs.list().filter((j) => !isTerminalJob(j.state)),
      ).has(name),
    finishedAt: (id) => {
      const f = server.jobs.get(id)?.finishedAt;
      return f ? Date.parse(f) : undefined;
    },
    log: (m) => process.stderr.write(`[ezcoder node] ${m}\n`),
  });
  setTimeout(() => gc.sweep(), 60_000).unref();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    gc.stop();
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
    `address   ${cfg.tlsCert ? "https://" : ""}${cfg.advertiseHost}:${cfg.port}${cfg.bind ? ` (bind ${cfg.bind})` : " (bind: Tailscale IP)"}`,
  );
  out(`labels    ${cfg.labels.join(",") || "-"}`);
  out(`slots     ${cfg.slots}`);
  out(`secrets   ${new NodeSecrets(dataDir, unavailableStore).list().join(", ") || "-"}`);
  try {
    const res = await localNodeFetch(cfg, "/v1/info");
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

async function cmdDoctor(args: string[], dataDir: string): Promise<void> {
  const repo = flag(args, "--repo");
  const cfg = requireConfig(dataDir);
  const report = await runDoctor({
    config: cfg,
    repo,
    modelProviders: () => new AuthStorage().listProviders(),
  });
  out(formatDoctorReport(report));
  if (!report.ok) process.exitCode = 1;
}

/** Terminal QR (half-height blocks) of `text`. */
export function qrText(text: string): Promise<string> {
  return new Promise((resolve) => qrcode.generate(text, { small: true }, resolve));
}

async function cmdPair(args: string[], dataDir: string): Promise<void> {
  const cfg = requireConfig(dataDir);
  const pairing = pairingFor(cfg);
  if (!bool(args, "--code")) {
    out(pairing);
    return;
  }
  const code = createPairCode(dataDir);
  out(`Pairing code: ${code}   (valid 10 minutes, works once)`);
  out(
    `Enter it on your main machine when adding this node (${cfg.tlsCert ? "https://" : ""}${cfg.advertiseHost}:${cfg.port}),`,
  );
  out("or scan this QR code; it holds the full pairing string, token included:");
  out(await qrText(pairing));
}

async function cmdRotateToken(dataDir: string): Promise<void> {
  const cfg = requireConfig(dataDir);
  // A running node swaps the token in memory as well, so the old one stops working at once.
  let serving = false;
  try {
    const res = await localNodeFetch(cfg, "/v1/token/rotate", { method: "POST", body: {} });
    serving = true;
    if (res.ok) {
      const r = (await res.json()) as RotateTokenResponse;
      out("New token issued; the old one no longer works. Pair again from the main machine:");
      out(`  ezcoder fleet add '${r.pairing}'`);
      return;
    }
  } catch {
    // not serving: rotating the file is enough
  }
  const next = rotateNodeToken(dataDir);
  out("New token saved; the old one no longer works. Pair again from the main machine:");
  out(`  ezcoder fleet add '${pairingFor(next)}'`);
  if (serving) {
    out("The running `ezcoder node serve` still holds the old token: restart it now.");
  }
}

function numFlag(args: string[], name: string): number | undefined {
  const v = flag(args, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a number above 0`);
  return n;
}

function cmdConfig(args: string[], dataDir: string): void {
  const cfg = requireConfig(dataDir);
  const slots = intFlag(args, "--slots");
  const gcDays = numFlag(args, "--gc-days");
  const cacheCapGb = numFlag(args, "--cache-cap-gb");
  if (slots !== undefined) cfg.slots = slots;
  if (gcDays !== undefined) cfg.gcDays = gcDays;
  if (cacheCapGb !== undefined) cfg.cacheCapGb = cacheCapGb;
  const changed = slots !== undefined || gcDays !== undefined || cacheCapGb !== undefined;
  if (changed) writeNodeConfig(cfg);
  out(`slots         ${cfg.slots}`);
  out(`gc-days       ${cfg.gcDays ?? DEFAULT_GC_DAYS}`);
  out(`cache-cap-gb  ${cfg.cacheCapGb ?? DEFAULT_CACHE_CAP_GB}`);
  if (changed)
    out(`saved to ${path.join(dataDir, "node.json")}; a running node uses it without a restart`);
}

async function cmdUninstall(args: string[], dataDir: string): Promise<void> {
  const purge = bool(args, "--purge");
  const r = await uninstallNode({ dataDir, purge, platform: detectPlatform() });
  out(formatUninstall(r));
}

function printUpdate(r: UpdateResponse, serving: boolean): void {
  if (r.from === r.to) {
    out(`already on ezcoder ${r.to}`);
    return;
  }
  out(`updated ezcoder ${r.from} -> ${r.to}`);
  if (r.restarting) out("the node is restarting into the new version");
  else if (serving) out("restart `ezcoder node serve` to use it");
}

async function cmdUpdate(args: string[], dataDir: string): Promise<void> {
  const version = flag(args, "--version");
  const force = bool(args, "--force");
  const request = { ...(version && { version }), ...(force && { force: true }) };
  const cfg = liveConfig(dataDir);
  if (cfg) {
    let res: Response | undefined;
    try {
      res = await localNodeFetch(cfg, "/v1/update", {
        method: "POST",
        body: request,
        timeoutMs: 600_000,
      });
    } catch {
      res = undefined; // not serving: update in place below
    }
    if (res && res.status !== 404) {
      const body = (await res.json().catch(() => ({}))) as UpdateResponse & ErrorResponse;
      if (!res.ok) throw new Error(body.error ?? `the node answered HTTP ${res.status}`);
      printUpdate(body, true);
      return;
    }
  }
  // Jobs run detached and outlive `node serve`, so count what the state file says is unfinished.
  try {
    const r = await installUpdate({
      request,
      activeWork: () => stateJobs(dataDir).filter(unfinished).length,
      underService: () => false,
    });
    printUpdate(r, false);
    const svc = loginServiceFile(detectPlatform());
    if (r.from !== r.to && svc && fs.existsSync(svc.file) && !runningUnderService()) {
      out("start it again with the login service, or run `ezcoder node serve`");
    }
  } catch (e) {
    if (e instanceof UpdateError) throw new Error(e.message, { cause: e });
    throw e;
  }
}

/** Test seams for `runNode`. */
export interface RunNodeDeps {
  /** Deploy-secret keychain (X8); tests inject an in-memory or unavailable one. */
  secretStore?: SecretStore;
  /** Secret value instead of stdin (tests). */
  readValue?: () => Promise<string>;
}

async function cmdSecret(args: string[], dataDir: string, deps: RunNodeDeps): Promise<void> {
  requireConfig(dataDir);
  const action = args.shift();
  const name = args.shift();
  // X8: values live in the OS keychain only; no plain-text fallback.
  const secrets = new NodeSecrets(dataDir, deps.secretStore ?? defaultSecretStore());
  const migrated = await secrets.migrateLegacy();
  if (migrated) out(migrated);
  if (action === "list") {
    const names = secrets.list();
    out(names.length ? names.join("\n") : "(no secrets)");
    return;
  }
  if (action === "set" && name) {
    const value = await (deps.readValue ?? readStdin)();
    if (!value)
      throw new Error(
        'empty value: pipe it in, e.g. `printf %s "$TOKEN" | ezcoder node secret set NAME`',
      );
    await secrets.set(name, value);
    out(
      `secret ${name} saved in the ${secrets.kind} (only jobs on nodes labelled 'deploy' can use it)`,
    );
    return;
  }
  if (action === "rm" && name) {
    out((await secrets.remove(name)) ? `secret ${name} removed` : `no secret named ${name}`);
    return;
  }
  throw new Error("usage: ezcoder node secret set NAME | list | rm NAME");
}

function cmdInstall(dataDir: string): void {
  requireConfig(dataDir);
  const platform = detectPlatform();
  const cmd = serveCommand(dataDir);
  if (platform === "macos") {
    const plist = loginServiceFile(platform)!.file;
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
  const unit = loginServiceFile(platform)!.file;
  fs.mkdirSync(path.dirname(unit), { recursive: true });
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

export async function runNode(
  argv: string[] = process.argv.slice(2),
  deps: RunNodeDeps = {},
): Promise<void> {
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
      return cmdPair(args, dataDir);
    case "doctor":
      return cmdDoctor(args, dataDir);
    case "rotate-token":
      return cmdRotateToken(dataDir);
    case "config":
      return cmdConfig(args, dataDir);
    case "uninstall":
      return cmdUninstall(args, dataDir);
    case "update":
      return cmdUpdate(args, dataDir);
    case "secret":
      return cmdSecret(args, dataDir, deps);
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
