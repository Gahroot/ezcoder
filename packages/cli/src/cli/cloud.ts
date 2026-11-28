// `ezcoder cloud …`: Claude Code cloud and Codex cloud as extra capacity.
// Providers connect from the user's existing EZ Coder sign-ins; this only
// shows their state and edits ~/.ezcoder/cloud.json.
import {
  cloudAllowedFor,
  cloudSettingsFile,
  DEFAULT_MAX_PLAN_UTILIZATION,
  providerOrder,
  providerSettings,
  readCloudSettings,
  readCloudState,
  writeCloudSettings,
  type CloudSettings,
  type CloudState,
  type CloudUse,
} from "../core/cloud/config.js";
import {
  CLOUD_LABELS,
  isCloudProviderId,
  type CloudAvailability,
  type CloudProviderId,
} from "../core/cloud/types.js";

const USES: readonly CloudUse[] = ["validation", "jobs", "agents"];

const HELP = `ezcoder cloud — Claude Code cloud and Codex cloud as extra capacity

  status                          each provider: connected, account, environment, plan use, what it runs
  on [provider] | off [provider]  turn cloud (or one provider: claude, codex) on or off
  use validation,jobs,agents      what cloud may run
  when overflow|always|manual     overflow (default): only when your machines have no room
  limit <percent>                 stop sending work past this weekly plan use (default 80)
  prefer codex|claude             which provider gets work first (default codex, saving Claude for coding)
  setup claude                    create the default Claude Code cloud environment
  setup codex                     connect GitHub to Codex (opens the page, waits), then make this repo's environment`;

export interface CloudCliDeps {
  file?: string;
  settings?: () => CloudSettings;
  state?: () => CloudState;
  availability?: (settings: CloudSettings) => Promise<CloudAvailability[]>;
  /** Create the default Claude Code cloud environment. */
  setupClaude?: () => Promise<{ environmentId: string; name: string }>;
  /** Codex setup steps (tests replace them). */
  codex?: CodexSetupDeps;
  out?: (line: string) => void;
}

function providerArg(value: string | undefined): CloudProviderId | undefined {
  if (!value) return undefined;
  const id = value.endsWith("-cloud") ? value : `${value}-cloud`;
  if (!isCloudProviderId(id)) {
    throw new Error(`unknown cloud provider "${value}" (claude or codex)`);
  }
  return id;
}

/** Status lines for every provider. */
export function describeCloudStatus(
  avail: readonly CloudAvailability[],
  settings: CloudSettings,
  state: CloudState,
  now = Date.now(),
): string[] {
  const lines: string[] = [];
  const when = settings.when ?? "overflow";
  const uses = USES.filter((u) => cloudAllowedFor(settings, u));
  const cap = settings.maxPlanUtilization ?? DEFAULT_MAX_PLAN_UTILIZATION;
  lines.push(
    settings.enabled === false
      ? "Cloud is OFF (ezcoder cloud on)."
      : `Cloud: ${when}${when === "overflow" ? " (only when your machines have no room)" : ""}; ` +
          `runs ${uses.join(", ") || "nothing"}; plan cap ${Math.round(cap * 100)}%.`,
  );
  const order = providerOrder(settings);
  lines.push(
    `Order: ${order.map((id) => CLOUD_LABELS[id]).join(" first, then ")} ` +
      "(test gates and jobs only use Claude Code cloud: its results can be checked).",
  );
  for (const id of order) {
    const a = avail.find((x) => x.id === id) ?? { id, available: false, detail: "not checked" };
    const p = providerSettings(settings, id);
    lines.push(`${id} (${CLOUD_LABELS[id]}): ${a.available ? "connected" : "not available"}`);
    if (a.account) lines.push(`  account: ${a.account}`);
    if (a.environmentId || a.environmentName) {
      lines.push(
        `  environment: ${[a.environmentName, a.environmentId].filter(Boolean).join(" ")}`,
      );
    }
    const util = state.utilization?.[id];
    if (util) {
      lines.push(
        `  plan used: ${Math.round(util.value * 100)}% (seen ${new Date(util.at).toLocaleString()}` +
          `${util.resetsAt ? `, resets ${new Date(util.resetsAt).toLocaleString()}` : ""})`,
      );
    }
    const bench = state.benched?.[id];
    const until =
      a.limitedUntil ?? (bench && Date.parse(bench.until) > now ? bench.until : undefined);
    if (until) lines.push(`  paused until ${new Date(until).toLocaleString()}`);
    lines.push(
      a.available
        ? `  used for: ${uses.join(", ") || "nothing"} (${when}, up to ${p.maxConcurrent} at once)`
        : `  ${a.detail}`,
    );
    if (!a.available && a.setupHint) lines.push(`  setup: ${a.setupHint}`);
  }
  return lines;
}

export interface CodexSetupDeps {
  connected: () => Promise<boolean>;
  open: (url: string) => void;
  /** This folder's GitHub repo ("owner/name"), if any. */
  repo: () => Promise<string | undefined>;
  ensure: (
    repo: string,
  ) => Promise<
    | { kind: "env"; env: { id: string; label?: string | null }; created?: boolean }
    | { kind: "creatable"; repo: string }
    | { kind: "missing"; detail: string; hint: string }
  >;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the GitHub approval (default 15 min). */
  waitMs?: number;
}

function openInBrowser(url: string): void {
  void import("node:child_process").then(({ spawn }) => {
    const [cmd, args] =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["cmd", ["/c", "start", "", url]]
          : ["xdg-open", [url]];
    try {
      spawn(cmd, args, { stdio: "ignore", detached: true })
        .on("error", () => {})
        .unref();
    } catch {
      // No browser here: the URL is printed too.
    }
  });
}

async function defaultCodexDeps(): Promise<CodexSetupDeps> {
  const { CodexCloudProvider } = await import("../core/cloud/codex.js");
  const { runGit, githubRepoFromUrl } = await import("../core/cloud/git.js");
  const codex = new CodexCloudProvider();
  return {
    connected: () => codex.githubConnected(),
    open: openInBrowser,
    repo: async () => {
      const origin = await runGit(process.cwd(), ["remote", "get-url", "origin"]).catch(
        () => undefined,
      );
      return origin?.code === 0 ? githubRepoFromUrl(origin.stdout.toString()) : undefined;
    },
    ensure: (repo) => codex.findEnvironment(repo, { create: true }),
  };
}

/** Connect GitHub (the one approval only the user can give), then the environment. */
export async function setupCodex(deps: CodexSetupDeps, out: (s: string) => void): Promise<void> {
  const { CODEX_CONNECT_URL } = await import("../core/cloud/codex.js");
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  if (!(await deps.connected())) {
    out("Codex needs GitHub access, which only you can approve (one click on github.com).");
    out(`Opening ${CODEX_CONNECT_URL}: click Connect next to GitHub and approve.`);
    deps.open(CODEX_CONNECT_URL);
    out("Waiting for the connection...");
    const deadline = Date.now() + (deps.waitMs ?? 15 * 60_000);
    let ok = false;
    while (Date.now() < deadline) {
      await sleep(5_000);
      if (await deps.connected()) {
        ok = true;
        break;
      }
    }
    if (!ok) {
      throw new Error(
        "GitHub still isn't connected to Codex. Finish it on that page, then run `ezcoder cloud setup codex` again.",
      );
    }
  }
  out("GitHub is connected to Codex.");
  const repo = await deps.repo();
  if (!repo) {
    out(
      "Codex cloud is ready. Environments are created automatically for each GitHub repo you use it in.",
    );
    return;
  }
  const result = await deps.ensure(repo);
  if (result.kind === "env") {
    const name = result.env.label ?? result.env.id;
    out(
      result.created
        ? `Created the Codex environment "${name}" for ${repo}. Other repos get theirs automatically on first use.`
        : `Codex environment for ${repo}: ${name}. Ready.`,
    );
    return;
  }
  if (result.kind === "missing") throw new Error(`${result.detail}. ${result.hint}.`);
  out(`Codex cloud is ready for ${repo}.`);
}

export async function runCloud(
  argv: string[] = process.argv.slice(2),
  deps: CloudCliDeps = {},
): Promise<void> {
  const args = [...argv];
  const action = args.shift() ?? "status";
  const file = deps.file ?? cloudSettingsFile();
  const read = deps.settings ?? (() => readCloudSettings(file));
  const out = deps.out ?? ((s: string) => process.stdout.write(s + "\n"));
  const save = (next: CloudSettings) => writeCloudSettings(next, file);

  switch (action) {
    case "status": {
      const settings = read();
      const availability =
        deps.availability ??
        (async (s: CloudSettings) => {
          const { cloudAvailability } = await import("../core/cloud/registry.js");
          // Detect every provider regardless of `use`, so status shows the account.
          return cloudAvailability(
            "jobs",
            { repoRoot: process.cwd() },
            {
              ...s,
              enabled: true,
              use: [...USES],
            },
          );
        });
      const avail = await availability(settings);
      for (const l of describeCloudStatus(avail, settings, (deps.state ?? readCloudState)())) {
        out(l);
      }
      return;
    }
    case "on":
    case "off": {
      const on = action === "on";
      const id = providerArg(args[0]);
      const s = read();
      if (id) {
        const providers = { ...s.providers, [id]: { ...s.providers?.[id], enabled: on } };
        save({ ...s, providers, ...(on && s.enabled === false ? { enabled: true } : {}) });
        out(`${CLOUD_LABELS[id]} turned ${action}.`);
      } else {
        save({ ...s, enabled: on });
        out(`Cloud turned ${action}.`);
      }
      return;
    }
    case "use": {
      const list = (args[0] ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      const bad = list.filter((x) => !(USES as readonly string[]).includes(x));
      if (!list.length || bad.length) {
        throw new Error(`usage: ezcoder cloud use ${USES.join(",")} (any of them)`);
      }
      save({ ...read(), use: list as CloudUse[] });
      out(`Cloud runs: ${list.join(", ")}.`);
      return;
    }
    case "when": {
      const when = args[0];
      if (when !== "overflow" && when !== "always" && when !== "manual") {
        throw new Error("usage: ezcoder cloud when overflow|always|manual");
      }
      save({ ...read(), when });
      out(`Cloud gets work: ${when}.`);
      return;
    }
    case "limit": {
      const pct = Number((args[0] ?? "").replace(/%$/, ""));
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        throw new Error("usage: ezcoder cloud limit <percent 1-100>");
      }
      save({ ...read(), maxPlanUtilization: pct / 100 });
      out(`Cloud stops taking work past ${pct}% weekly plan use.`);
      return;
    }
    case "prefer": {
      const id = providerArg(args[0]);
      if (!id) throw new Error("usage: ezcoder cloud prefer codex|claude");
      const s = read();
      save({ ...s, order: [id, ...providerOrder(s).filter((x) => x !== id)] });
      out(`${CLOUD_LABELS[id]} gets cloud work first.`);
      return;
    }
    case "setup": {
      const id = providerArg(args[0] ?? "claude");
      if (id !== "claude-cloud") {
        await setupCodex(deps.codex ?? (await defaultCodexDeps()), out);
        return;
      }
      const setup =
        deps.setupClaude ??
        (async () => {
          const { ClaudeCloudProvider } = await import("../core/cloud/claude.js");
          return new ClaudeCloudProvider().createDefaultEnvironment();
        });
      const env = await setup();
      out(`Claude Code cloud environment ready: ${env.name} (${env.environmentId}).`);
      return;
    }
    case "help":
      out(HELP);
      return;
    default:
      out(HELP);
      process.exitCode = 1;
  }
}
