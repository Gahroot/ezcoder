// Claude Code cloud sessions (claude.ai/code) as a cloud provider, reached
// with the Claude subscription sign-in EZ Coder already holds. The code goes
// up as a one-commit seed bundle, a session runs the prompt in Anthropic's
// sandbox, and the harness's event log (Bash tool_use + tool_result) is the
// record of what really ran. API facts: goal notes cloud-api-notes.md.
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { AuthStorage, NotLoggedInError } from "../auth-storage.js";
import {
  benchProvider,
  providerSettings,
  readCloudSettings,
  recordUtilization,
  type CloudSettings,
} from "./config.js";
import { bundleOf, commitSnapshot, workingTreeSnapshot, type Snapshot } from "./snapshot.js";
import {
  CloudError,
  type CloudAvailability,
  type CloudCommandRecord,
  type CloudProvider,
  type CloudTaskHandle,
  type CloudTaskRequest,
  type CloudTaskState,
  type CloudTaskStatus,
} from "./types.js";

export const CLAUDE_API = "https://api.anthropic.com";
export const CLAUDE_SESSION_URL = "https://claude.ai/code/";
/** Cheapest capable model: a runner only relays one command. */
export const DEFAULT_RUNNER_MODEL = "claude-haiku-5-5";
const CCR_BETA = "ccr-byoc-2025-07-29";
const OAUTH_BETA = "oauth-2025-04-20";
const FILES_BETA = "files-api-2025-04-14,oauth-2025-04-20";
const CONTEXT_TTL_MS = 10 * 60_000;
const EVENT_PAGES_PER_POLL = 50;
const ACTIVITY_KEEP = 20;
/** Bash timeouts when the caller gives none (Claude Code's own long-run settings). */
const DEFAULT_BASH_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_BASH_MAX_TIMEOUT_MS = 2 * 3_600_000;
const NOT_SIGNED_IN_HINT = "Sign in to Claude in EZ Coder (/login)";

interface Credentials {
  accessToken: string;
}

/** The slice of AuthStorage this provider uses. */
export interface ClaudeAuth {
  resolveCredentials(
    provider: string,
    opts?: { forceRefresh?: boolean; rejectedToken?: string },
  ): Promise<Credentials>;
}

export interface ClaudeCloudDeps {
  fetch: typeof fetch;
  auth: ClaudeAuth;
  settings: () => CloudSettings;
  recordUtilization: typeof recordUtilization;
  benchProvider: typeof benchProvider;
  commitSnapshot: (repoRoot: string, sha: string) => Promise<Snapshot>;
  workingTreeSnapshot: (repoRoot: string) => Promise<Snapshot>;
  bundleOf: (repoRoot: string, commit: string) => Promise<Buffer>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

interface Profile {
  account?: { email?: string; has_claude_max?: boolean; has_claude_pro?: boolean };
  organization?: { uuid?: string; organization_type?: string };
}

interface Environment {
  kind?: string;
  environment_id?: string;
  name?: string;
  state?: string;
}

interface Context {
  at: number;
  org: string;
  account: string;
  plan?: string;
  env?: Environment;
  /** Why there is no usable environment. */
  envProblem?: string;
}

type ClaudeEvent = Record<string, unknown> & { id?: string; type?: string };

interface Usage {
  limited: boolean;
  utilization?: number;
  resetsAt?: string;
}

/** What polling has learned about one session so far (events are read once). */
interface Track {
  cursor?: string;
  toolUses: Map<string, { name: string; input: Record<string, unknown> }>;
  commands: CloudCommandRecord[];
  finalText?: string;
  turns: number;
  usage?: Usage;
  /** A rate_limit_event arrived since the last status(). */
  usageFresh: boolean;
  activity: { tool: string; input: Record<string, unknown> }[];
  tokens: { input: number; output: number };
  lastLog?: string;
  resultError?: string;
  /** Permission prompts (can_use_tool) by request id, and the ones answered. */
  prompts: Map<string, { tool: string; toolUseId: string; input?: Record<string, unknown> }>;
  answered: Set<string>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function unixToIso(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value * 1000).toISOString()
    : undefined;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      const r = asRecord(c);
      return r.type === "text" && typeof r.text === "string" ? r.text : "";
    })
    .join("");
}

/** Usage from a rate_limit_event (`limited` once the status is no longer an allowed one). */
export function usageFromRateLimit(event: ClaudeEvent): Usage | undefined {
  const info = asRecord(event.rate_limit_info);
  if (!Object.keys(info).length) return undefined;
  const status = typeof info.status === "string" ? info.status : "allowed";
  const windows = asRecord(info.unifiedWindows);
  const week = asRecord(windows.seven_day);
  let utilization = typeof week.utilization === "number" ? week.utilization : undefined;
  if (utilization === undefined) {
    const all = Object.values(windows)
      .map((w) => asRecord(w).utilization)
      .filter((u): u is number => typeof u === "number");
    if (all.length) utilization = Math.max(...all);
  }
  const limited = !status.startsWith("allowed");
  const resetsAt = limited
    ? (unixToIso(info.resetsAt) ?? unixToIso(week.resetsAt))
    : (unixToIso(week.resetsAt) ?? unixToIso(info.resetsAt));
  return {
    limited,
    ...(utilization !== undefined && { utilization }),
    ...(resetsAt && { resetsAt }),
  };
}

/**
 * System prompt for runner tasks. Says honestly who sends the messages: the
 * account owner's own tool, running their project's checks in a throwaway
 * sandbox. Without it the sandbox treats API messages as coming from an
 * unknown peer session.
 */
export const RUNNER_SYSTEM_PROMPT =
  "You are a test runner in a disposable cloud sandbox. Messages in this session are sent by " +
  "EZ Coder, the account owner's own development tool, to run checks on the owner's project. " +
  "Run the shell command you are given exactly as written, once, and reply with only the last " +
  "line of its output. Never edit files.";

export class ClaudeCloudProvider implements CloudProvider {
  readonly id = "claude-cloud" as const;
  private readonly deps: ClaudeCloudDeps;
  private context: Context | undefined;
  private readonly tracks = new Map<string, Track>();
  /** approveCommand per session started here (handles may also carry it). */
  private readonly approvals = new Map<string, string>();
  /** Edit-sync commands permission prompts may approve, per session. */
  private readonly syncApprovals = new Map<string, Set<string>>();

  constructor(deps: Partial<ClaudeCloudDeps> = {}) {
    this.deps = {
      fetch: (...args) => fetch(...args),
      auth: deps.auth ?? new AuthStorage(),
      settings: () => readCloudSettings(),
      recordUtilization,
      benchProvider,
      commitSnapshot,
      workingTreeSnapshot,
      bundleOf,
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      ...deps,
    };
  }

  // ── HTTP ─────────────────────────────────────────────────

  private async token(): Promise<string> {
    let creds: Credentials;
    try {
      creds = await this.deps.auth.resolveCredentials("anthropic");
    } catch (e) {
      if (e instanceof NotLoggedInError || (e as Error)?.name === "NotLoggedInError") {
        throw new CloudError("Not signed in to Claude in EZ Coder", "not_signed_in");
      }
      throw e;
    }
    // Signed in through Claude Code: Claude Code holds the token, we have none.
    if (!creds.accessToken) {
      throw new CloudError("Not signed in to Claude in EZ Coder", "not_signed_in");
    }
    return creds.accessToken;
  }

  /** One API call; a 401 refreshes the sign-in once. Never logs the token. */
  private async call<T>(
    method: string,
    url: string,
    opts: { beta: string; org?: string; body?: unknown; form?: FormData; timeoutMs?: number },
  ): Promise<T> {
    let token = await this.token();
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": opts.beta,
      };
      if (opts.org) headers["x-organization-uuid"] = opts.org;
      if (opts.body !== undefined) headers["content-type"] = "application/json";
      let res: Response;
      try {
        res = await this.deps.fetch(CLAUDE_API + url, {
          method,
          headers,
          ...(opts.form
            ? { body: opts.form }
            : opts.body !== undefined
              ? { body: JSON.stringify(opts.body) }
              : {}),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
        });
      } catch (e) {
        throw new CloudError(
          `Claude cloud unreachable: ${e instanceof Error ? e.message : String(e)}`,
          "unreachable",
        );
      }
      if (res.status === 401 && attempt === 0) {
        const fresh = await this.deps.auth
          .resolveCredentials("anthropic", { forceRefresh: true, rejectedToken: token })
          .catch(() => undefined);
        if (fresh?.accessToken) {
          token = fresh.accessToken;
          continue;
        }
      }
      const text = await res.text();
      if (!res.ok) throw this.httpError(method, url, res, text);
      try {
        return (text ? JSON.parse(text) : {}) as T;
      } catch {
        throw new CloudError(`Claude cloud ${method} ${url}: bad JSON reply`, "http", res.status);
      }
    }
  }

  private httpError(method: string, url: string, res: Response, text: string): CloudError {
    const path = url.split("?")[0];
    const brief = text.replace(/\s+/g, " ").slice(0, 300);
    const msg = `Claude cloud ${method} ${path}: HTTP ${res.status}${brief ? ` ${brief}` : ""}`;
    const limit = /usage limit|rate[_ ]?limit|quota|exceeded your/i.test(text);
    if (res.status === 429 || (res.status >= 400 && res.status < 500 && limit)) {
      const retry = Number(res.headers.get("retry-after"));
      const until =
        Number.isFinite(retry) && retry > 0
          ? new Date(this.deps.now() + retry * 1000).toISOString()
          : undefined;
      return new CloudError(msg, "usage_limited", res.status, until);
    }
    if (res.status === 401) return new CloudError(msg, "not_signed_in", 401);
    if (res.status === 403) return new CloudError(msg, "not_allowed", 403);
    if (res.status === 404) return new CloudError(msg, "not_found", 404);
    return new CloudError(msg, "http", res.status);
  }

  // ── account and environment ──────────────────────────────

  private async loadContext(force = false): Promise<Context> {
    const now = this.deps.now();
    if (!force && this.context && now - this.context.at < CONTEXT_TTL_MS) return this.context;
    const profile = await this.call<Profile>("GET", "/api/oauth/profile", { beta: OAUTH_BETA });
    const org = profile.organization?.uuid;
    if (!org) throw new CloudError("Claude profile has no organization", "not_allowed");
    const a = profile.account ?? {};
    const orgType = profile.organization?.organization_type ?? "";
    const plan = a.has_claude_max
      ? "Max"
      : a.has_claude_pro
        ? "Pro"
        : /team/i.test(orgType)
          ? "Team"
          : /enterprise/i.test(orgType)
            ? "Enterprise"
            : undefined;
    const ctx: Context = {
      at: now,
      org,
      account: a.email ?? "Claude account",
      ...(plan && { plan }),
    };
    if (plan) {
      const list = await this.call<{ environments?: Environment[] }>(
        "GET",
        "/v1/environment_providers",
        { beta: CCR_BETA, org },
      );
      const envs = list.environments ?? [];
      const wanted = providerSettings(this.deps.settings(), this.id).environment;
      const cloud = envs.filter((e) => e.kind === "anthropic_cloud" && e.state !== "archived");
      const active = cloud.filter((e) => !e.state || e.state === "active");
      const env = wanted
        ? envs.find((e) => e.environment_id === wanted || e.name === wanted)
        : (active.find((e) => e.name === "Default") ?? active[0]);
      if (env) ctx.env = env;
      else
        ctx.envProblem = wanted
          ? `environment "${wanted}" (~/.ezcoder/cloud.json) not found in this Claude account`
          : "no Claude Code cloud environment yet";
    }
    this.context = ctx;
    return ctx;
  }

  async detect(): Promise<CloudAvailability> {
    let ctx: Context;
    try {
      ctx = await this.loadContext();
    } catch (e) {
      if (e instanceof CloudError && e.code === "not_signed_in") {
        return {
          id: this.id,
          available: false,
          detail: "not signed in to Claude",
          setupHint: NOT_SIGNED_IN_HINT,
        };
      }
      return { id: this.id, available: false, detail: e instanceof Error ? e.message : String(e) };
    }
    const account = ctx.plan ? `${ctx.account} (${ctx.plan})` : ctx.account;
    if (!ctx.plan) {
      return {
        id: this.id,
        available: false,
        account,
        detail: `${ctx.account} has no Claude Pro, Max or Team plan (needed for Claude Code cloud)`,
        setupHint: "Sign in to Claude with a Pro, Max or Team account",
      };
    }
    if (!ctx.env?.environment_id) {
      return {
        id: this.id,
        available: false,
        account,
        detail: `${account}: ${ctx.envProblem ?? "no cloud environment"}`,
        setupHint:
          "Run `ezcoder cloud setup` to create the Default Claude Code cloud environment " +
          "(or open claude.ai/code once)",
      };
    }
    const name = ctx.env.name ?? ctx.env.environment_id;
    return {
      id: this.id,
      available: true,
      account,
      environmentId: ctx.env.environment_id,
      environmentName: name,
      detail: `${account}, environment ${name}`,
    };
  }

  /**
   * Create the "Default" cloud environment the way Claude Code's CLI does
   * (trusted network access, Python + Node). Only on explicit user action.
   */
  async createDefaultEnvironment(): Promise<{ environmentId: string; name: string }> {
    const ctx = await this.loadContext(true);
    if (!ctx.plan)
      throw new CloudError(`${ctx.account} has no Claude Pro/Max/Team plan`, "not_allowed");
    if (ctx.env?.environment_id) {
      return { environmentId: ctx.env.environment_id, name: ctx.env.name ?? "Default" };
    }
    const created = await this.call<Environment & { id?: string }>(
      "POST",
      "/v1/environment_providers/cloud/create",
      {
        beta: CCR_BETA,
        org: ctx.org,
        body: {
          name: "Default",
          kind: "anthropic_cloud",
          description: "Default - trusted network access",
          config: {
            environment_type: "anthropic",
            cwd: "/home/user",
            init_script: null,
            environment: {},
            languages: [
              { name: "python", version: "3.11" },
              { name: "node", version: "20" },
            ],
            network_config: { allowed_hosts: [], allow_default_hosts: true },
          },
        },
      },
    );
    this.context = undefined;
    const environmentId = created.environment_id ?? created.id;
    if (!environmentId) throw new CloudError("environment create returned no id", "http");
    return { environmentId, name: created.name ?? "Default" };
  }

  /** Account, org and environment for a task, or a CloudError saying why not. */
  private async ready(): Promise<Context & { env: Environment & { environment_id: string } }> {
    const ctx = await this.loadContext();
    if (!ctx.plan)
      throw new CloudError(`${ctx.account} has no Claude Pro/Max/Team plan`, "not_allowed");
    if (!ctx.env?.environment_id) {
      throw new CloudError(ctx.envProblem ?? "no Claude Code cloud environment", "no_environment");
    }
    return ctx as Context & { env: Environment & { environment_id: string } };
  }

  // ── tasks ────────────────────────────────────────────────

  async start(request: CloudTaskRequest): Promise<CloudTaskHandle> {
    const ctx = await this.ready();
    const { repoRoot, sha } = request.source;
    // Agents send their uncommitted work: snapshot it from the working tree.
    const snap = request.source.patch
      ? await this.deps.workingTreeSnapshot(repoRoot)
      : await this.deps.commitSnapshot(repoRoot, sha);
    const bundle = await this.deps.bundleOf(repoRoot, snap.commit);

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bundle)]), "repo.bundle");
    form.append("purpose", "user_data");
    const file = await this.call<{ id?: string }>("POST", "/v1/files", {
      beta: FILES_BETA,
      org: ctx.org,
      form,
      timeoutMs: 15 * 60_000,
    });
    if (!file.id) throw new CloudError("bundle upload returned no file id", "http");

    const settings = providerSettings(this.deps.settings(), this.id);
    const bashMs =
      request.commandTimeoutMinutes !== undefined
        ? Math.min((Math.ceil(request.commandTimeoutMinutes) + 5) * 60_000, 24 * 3_600_000)
        : undefined;
    const env: Record<string, string> = {
      ...request.env,
      BASH_DEFAULT_TIMEOUT_MS: String(bashMs ?? DEFAULT_BASH_TIMEOUT_MS),
      BASH_MAX_TIMEOUT_MS: String(bashMs ?? DEFAULT_BASH_MAX_TIMEOUT_MS),
    };
    const sessionContext: Record<string, unknown> = {
      sources: [],
      outcomes: [],
      seed_bundle_file_id: file.id,
      environment_variables: env,
      model: request.model ?? settings.runnerModel ?? DEFAULT_RUNNER_MODEL,
      ...(request.maxTurns !== undefined && { max_turns: request.maxTurns }),
      ...(request.disallowedTools?.length && { disallowed_tools: request.disallowedTools }),
      // Runner tasks: a one-line system prompt and the shell tool only. Half
      // the tokens of the default prompt (measured: ~$0.008 vs ~$0.02 a stage).
      ...(request.runner && {
        custom_system_prompt: RUNNER_SYSTEM_PROMPT,
        builtin_tools: ["Bash"],
      }),
    };
    const created = await this.call<{ id?: string }>("POST", "/v1/sessions", {
      beta: CCR_BETA,
      org: ctx.org,
      body: {
        title: request.title.slice(0, 200),
        environment_id: ctx.env.environment_id,
        events: [{ type: "event", data: this.userEvent(request.prompt) }],
        session_context: sessionContext,
      },
    });
    if (!created.id) throw new CloudError("session create returned no id", "http");
    if (request.approveCommand) this.approvals.set(created.id, request.approveCommand);
    return {
      provider: this.id,
      id: created.id,
      url: CLAUDE_SESSION_URL + created.id,
      baseTree: snap.tree,
      baseCommit: snap.commit,
      repoRoot,
      ...(request.approveCommand && { approveCommand: request.approveCommand }),
    };
  }

  private userEvent(content: string): Record<string, unknown> {
    return {
      uuid: randomUUID(),
      session_id: "",
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content },
    };
  }

  private track(id: string): Track {
    let t = this.tracks.get(id);
    if (!t) {
      t = {
        toolUses: new Map(),
        commands: [],
        turns: 0,
        usageFresh: false,
        activity: [],
        tokens: { input: 0, output: 0 },
        prompts: new Map(),
        answered: new Set(),
      };
      this.tracks.set(id, t);
    }
    return t;
  }

  /** Read events after the cursor (paged) and fold them into the track. */
  private async pull(id: string, org: string, t: Track): Promise<void> {
    for (let page = 0; page < EVENT_PAGES_PER_POLL; page++) {
      const q = `/v1/sessions/${encodeURIComponent(id)}/events?limit=500${
        t.cursor ? `&after_id=${encodeURIComponent(t.cursor)}` : ""
      }`;
      const r = await this.call<{ data?: ClaudeEvent[]; has_more?: boolean; last_id?: string }>(
        "GET",
        q,
        { beta: CCR_BETA, org },
      );
      const data = r.data ?? [];
      for (const e of data) this.fold(t, e);
      const last = r.last_id ?? data.at(-1)?.id;
      if (typeof last === "string" && last) t.cursor = last;
      if (!r.has_more || !data.length) break;
    }
  }

  private fold(t: Track, e: ClaudeEvent): void {
    switch (e.type) {
      case "assistant": {
        const content = asRecord(e.message).content;
        if (!Array.isArray(content)) break;
        for (const item of content) {
          const c = asRecord(item);
          if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
            t.finalText = c.text;
          } else if (c.type === "tool_use" && typeof c.id === "string") {
            const tool = typeof c.name === "string" ? c.name : "?";
            const input = asRecord(c.input);
            t.toolUses.set(c.id, { name: tool, input });
            t.activity.push({ tool, input });
            if (t.activity.length > ACTIVITY_KEEP) t.activity.shift();
          }
        }
        break;
      }
      case "user": {
        const content = asRecord(e.message).content;
        if (!Array.isArray(content)) break;
        for (const item of content) {
          const c = asRecord(item);
          if (c.type !== "tool_result" || typeof c.tool_use_id !== "string") continue;
          const use = t.toolUses.get(c.tool_use_id);
          if (!use || use.name !== "Bash" || typeof use.input.command !== "string") continue;
          t.commands.push({
            command: use.input.command,
            output: toolResultText(c.content),
            isError: c.is_error === true,
          });
        }
        break;
      }
      case "result": {
        t.turns++;
        t.resultError =
          e.is_error === true
            ? typeof e.result === "string" && e.result
              ? e.result
              : `turn ended with an error${typeof e.subtype === "string" ? ` (${e.subtype})` : ""}`
            : undefined;
        for (const u of Object.values(asRecord(e.model_usage_since_last_result))) {
          const m = asRecord(u);
          const n = (k: string) => (typeof m[k] === "number" ? (m[k] as number) : 0);
          t.tokens.input +=
            n("inputTokens") + n("cacheCreationInputTokens") + n("cacheReadInputTokens");
          t.tokens.output += n("outputTokens");
        }
        break;
      }
      case "rate_limit_event": {
        const usage = usageFromRateLimit(e);
        if (usage) {
          t.usage = usage;
          t.usageFresh = true;
        }
        break;
      }
      case "control_request": {
        const req = asRecord(e.request);
        if (req.subtype !== "can_use_tool" || typeof e.request_id !== "string") break;
        const input = asRecord(req.input);
        t.prompts.set(e.request_id, {
          tool: typeof req.tool_name === "string" ? req.tool_name : "?",
          toolUseId: typeof req.tool_use_id === "string" ? req.tool_use_id : "",
          ...(Object.keys(input).length && { input }),
        });
        break;
      }
      case "control_response": {
        const id = asRecord(e.response).request_id;
        if (typeof id === "string") t.answered.add(id);
        break;
      }
      case "env_manager_log": {
        const content = asRecord(e.data).content;
        if (typeof content === "string") t.lastLog = content;
        break;
      }
      default:
        break;
    }
  }

  async status(handle: CloudTaskHandle): Promise<CloudTaskStatus> {
    const ctx = await this.loadContext();
    // Status first, then events: an idle session's final events are already written.
    const session = await this.call<{ session_status?: string }>(
      "GET",
      `/v1/sessions/${encodeURIComponent(handle.id)}`,
      { beta: CCR_BETA, org: ctx.org },
    );
    const t = this.track(handle.id);
    await this.pull(handle.id, ctx.org, t);
    const answeredNow = await this.answerPrompts(handle, ctx.org, t);

    if (t.usageFresh && t.usage) {
      t.usageFresh = false;
      if (t.usage.utilization !== undefined) {
        this.deps.recordUtilization(this.id, t.usage.utilization, t.usage.resetsAt);
      }
      if (t.usage.limited) {
        const until = t.usage.resetsAt ?? new Date(this.deps.now() + 3_600_000).toISOString();
        this.deps.benchProvider(this.id, until, "Claude plan usage limit reached");
      }
    }

    let state: CloudTaskState;
    switch (session.session_status) {
      case "pending":
        state = "starting";
        break;
      case "running":
        state = "running";
        break;
      case "requires_action":
        // A permission prompt: answered above (allow our command, deny the rest).
        state = "running";
        break;
      case "idle":
        // Idle before the first turn ends = still being set up.
        state = t.turns > 0 ? "idle" : "starting";
        break;
      case "failed":
        state = "failed";
        break;
      case "archived":
        state = "cancelled";
        break;
      default:
        state = "running";
    }
    const error =
      state === "failed"
        ? (t.resultError ?? `session failed${t.lastLog ? ` (last: ${t.lastLog})` : ""}`)
        : t.resultError;
    if (answeredNow && state === "idle") state = "running";
    return {
      state,
      ...(t.finalText !== undefined && { finalText: t.finalText }),
      commands: [...t.commands],
      turns: t.turns,
      ...(t.usage && { usage: { ...t.usage } }),
      ...(error && { error }),
      ...(t.activity.length && { activity: [...t.activity] }),
      usageTokens: { ...t.tokens },
    };
  }

  /**
   * Answer pending permission prompts: allow a Bash call whose command is
   * byte-identical to the task's approveCommand, deny everything else.
   * (Verified live: control_response via POST /v1/sessions/<id>/events.)
   */
  private async answerPrompts(handle: CloudTaskHandle, org: string, t: Track): Promise<number> {
    const approve = handle.approveCommand ?? this.approvals.get(handle.id);
    const sync = this.syncApprovals.get(handle.id);
    let n = 0;
    for (const [requestId, p] of t.prompts) {
      if (t.answered.has(requestId)) continue;
      const input = t.toolUses.get(p.toolUseId)?.input ?? p.input;
      const command = input?.command;
      const ok =
        p.tool === "Bash" &&
        typeof command === "string" &&
        (command === approve || (sync?.has(command) ?? false));
      const response = ok
        ? { behavior: "allow", updatedInput: input, toolUseID: p.toolUseId }
        : { behavior: "deny", message: "Only the given command may run." };
      await this.call("POST", `/v1/sessions/${encodeURIComponent(handle.id)}/events`, {
        beta: CCR_BETA,
        org,
        body: {
          events: [
            {
              uuid: randomUUID(),
              type: "control_response",
              response: { subtype: "success", request_id: requestId, response },
            },
          ],
        },
      });
      t.answered.add(requestId);
      n++;
    }
    return n;
  }

  private async postEvents(handle: CloudTaskHandle, events: unknown[]): Promise<void> {
    const ctx = await this.loadContext();
    await this.call("POST", `/v1/sessions/${encodeURIComponent(handle.id)}/events`, {
      beta: CCR_BETA,
      org: ctx.org,
      body: { events },
    });
  }

  async send(handle: CloudTaskHandle, message: string): Promise<void> {
    await this.postEvents(handle, [this.userEvent(message)]);
  }

  async interrupt(handle: CloudTaskHandle): Promise<void> {
    await this.postEvents(handle, [
      {
        type: "control_request",
        request_id: `interrupt-${randomUUID()}`,
        request: { subtype: "interrupt" },
      },
    ]);
  }

  /**
   * The session's changes against `handle.baseCommit`, brought back through
   * the harness's own command record (never assistant text): a follow-up turn
   * asks the agent to run exact commands that print the sandbox's diff
   * gzipped + base64 between markers with its sha256 and length. A Bash
   * tool_result carries ~30 KB before Claude Code swaps it for a
   * <persisted-output> preview (measured live), so larger diffs come back in
   * numbered chunks in a second turn. Only when the session is idle.
   */
  async diff(handle: CloudTaskHandle): Promise<Buffer> {
    const base = handle.baseCommit;
    if (!base || !/^[0-9a-f]{40,64}$/.test(base)) {
      throw new CloudError("This session has no snapshot commit to diff against", "not_allowed");
    }
    const status = await this.status(handle);
    if (status.state !== "idle") {
      throw new CloudError(`session is ${status.state}, not idle; edits not synced`, "not_allowed");
    }
    const prepare = claudeSyncPrepareCommand(base);
    const first = await this.runSyncTurn(handle, [prepare], SYNC_PROMPT_ONE);
    const header = parseSyncOutput(first[0]!);
    if (header.empty) return Buffer.alloc(0);
    if (header.length > MAX_SYNC_B64_BYTES) {
      throw new CloudError(
        `the session's changes are ${Math.round(header.length / 1024)} KB packed, over the ` +
          `${MAX_SYNC_B64_BYTES / 1024} KB sync limit; they stay in the session: ${handle.url}`,
        "too_large",
      );
    }
    let data = header.data;
    if (data.length < header.length) {
      const chunks = claudeSyncChunkCommands(header.length).slice(1);
      const outputs = await this.runSyncTurn(handle, chunks, SYNC_PROMPT_MANY);
      for (const out of outputs) data += parseSyncChunk(out);
    }
    return decodeSyncPayload(data, header.sha256, header.length);
  }

  /** One follow-up turn running exactly `commands`; their recorded outputs, in order. */
  private async runSyncTurn(
    handle: CloudTaskHandle,
    commands: string[],
    prompt: string,
  ): Promise<string[]> {
    const before = await this.status(handle);
    const t = this.track(handle.id);
    const seen = t.commands.length;
    this.syncApprovals.set(handle.id, new Set(commands));
    try {
      const listed = commands.map((c) => "```\n" + c + "\n```").join("\n");
      await this.send(handle, `${prompt}\n${listed}`);
      const deadline = this.deps.now() + SYNC_TURN_TIMEOUT_MS;
      for (;;) {
        await this.deps.sleep(SYNC_POLL_MS);
        const s = await this.status(handle);
        if (s.state === "failed" || s.state === "cancelled") {
          throw new CloudError(`sync turn ${s.state}: ${s.error ?? ""}`.trim(), "http");
        }
        if (s.state === "idle" && s.turns > before.turns) break;
        if (this.deps.now() > deadline) {
          throw new CloudError("sync turn timed out", "unreachable");
        }
      }
      const fresh = t.commands.slice(seen);
      // Models wrap commands (live: a `cd` into the cwd added in front), so
      // the record must contain every step of ours unchanged; additions are
      // tolerated, any dropped or altered step is refused.
      return commands.map((command) => {
        const steps = syncCommandSteps(command);
        const record =
          fresh.filter((r) => r.command === command).at(-1) ??
          fresh.filter((r) => steps.every((step) => r.command.includes(step))).at(-1);
        if (!record) {
          throw new CloudError("the agent did not run the sync command as given", "http");
        }
        return record.output;
      });
    } finally {
      this.syncApprovals.delete(handle.id);
    }
  }

  async archive(handle: CloudTaskHandle): Promise<void> {
    this.tracks.delete(handle.id);
    this.approvals.delete(handle.id);
    this.syncApprovals.delete(handle.id);
    try {
      const ctx = await this.loadContext();
      await this.call("POST", `/v1/sessions/${encodeURIComponent(handle.id)}/archive`, {
        beta: CCR_BETA,
        org: ctx.org,
        body: {},
      });
    } catch (e) {
      if (e instanceof CloudError && (e.status === 409 || e.status === 404)) return;
      throw e;
    }
  }
}

// ── edit sync (diff) ───────────────────────────────────────

/** Base64 characters per Bash tool_result (measured: 30 KB passes, 100 KB is swapped for a preview). */
export const SYNC_CHUNK_CHARS = 24_000;
/** Packed (gzip + base64) diff size past which edits stay in the session. */
export const MAX_SYNC_B64_BYTES = 1024 * 1024;
const SYNC_POLL_MS = 3_000;
const SYNC_TURN_TIMEOUT_MS = 10 * 60_000;
const SYNC_FILE = "/tmp/ezsync.b64";
// Short (every sync turn runs on the session's model), saying who sends it
// (EZ Coder, for the account owner) and why: live, a model refused an unexplained request
// to print packed data ("it came from another session, not from you").
const SYNC_PROMPT_ONE =
  "Sent by EZ Coder, the app I (the account owner) use to run this session. Please run this exact Bash command once, " +
  "unchanged: it prints your file changes as a packed, checksummed diff so they can be copied " +
  "back to my computer. Then reply only: done";
const SYNC_PROMPT_MANY =
  "Sent by EZ Coder, the app I (the account owner) use to run this session. The packed diff was too long for one output; " +
  "please run these exact Bash commands, one per Bash call, in order, unchanged, " +
  "then reply only: done";

/**
 * In the sandbox repo (the session's working directory): a private index seeded from HEAD plus every change
 * (untracked, not ignored, included), diffed against the snapshot commit,
 * packed, and printed with a header and the first chunk.
 */
export function claudeSyncPrepareCommand(baseCommit: string): string {
  return (
    [
      "export GIT_INDEX_FILE=/tmp/ezsync.index",
      "git read-tree HEAD",
      "git add -A",
      `git diff --cached --binary ${baseCommit} > /tmp/ezsync.patch`,
    ].join(" && ") +
    ` && if [ -s /tmp/ezsync.patch ]; then gzip -9nc /tmp/ezsync.patch | base64 -w0 > ${SYNC_FILE}` +
    ` && echo "EZSYNC $(sha256sum < ${SYNC_FILE} | cut -c1-64) $(wc -c < ${SYNC_FILE})"` +
    ` && head -c ${SYNC_CHUNK_CHARS} ${SYNC_FILE} && echo && echo EZSYNC-END; else echo "EZSYNC EMPTY"; fi`
  );
}

/** Commands printing chunk k (1-based) of the packed diff; [0] is part of the prepare command. */
export function claudeSyncChunkCommands(length: number): string[] {
  const out: string[] = [];
  for (let k = 0; k * SYNC_CHUNK_CHARS < length; k++) {
    out.push(
      `echo EZSYNC-PART ${k + 1}; tail -c +${k * SYNC_CHUNK_CHARS + 1} ${SYNC_FILE} | ` +
        `head -c ${SYNC_CHUNK_CHARS}; echo; echo EZSYNC-END`,
    );
  }
  return out;
}

export function parseSyncOutput(
  output: string,
): { empty: true } | { empty: false; sha256: string; length: number; data: string } {
  const lines = output.replace(/\r/g, "").split("\n");
  const at = lines.findIndex((l) => l.startsWith("EZSYNC "));
  if (at < 0) {
    throw new CloudError(
      output.includes("persisted-output")
        ? "the sync output was cut off by the sandbox"
        : `the sync command printed no result: ${output.trim().slice(-300)}`,
      "http",
    );
  }
  const head = lines[at]!.trim();
  if (head === "EZSYNC EMPTY") return { empty: true };
  const m = /^EZSYNC ([0-9a-f]{64}) (\d+)$/.exec(head);
  const end = lines.indexOf("EZSYNC-END", at + 1);
  if (!m || end < 0) throw new CloudError("the sync output is malformed or cut off", "http");
  return {
    empty: false,
    sha256: m[1]!,
    length: Number(m[2]),
    data: lines
      .slice(at + 1, end)
      .join("")
      .trim(),
  };
}

export function parseSyncChunk(output: string): string {
  const lines = output.replace(/\r/g, "").split("\n");
  const at = lines.findIndex((l) => /^EZSYNC-PART \d+$/.test(l.trim()));
  const end = lines.indexOf("EZSYNC-END", at + 1);
  if (at < 0 || end < 0) throw new CloudError("a sync chunk is missing or cut off", "http");
  return lines
    .slice(at + 1, end)
    .join("")
    .trim();
}

export function decodeSyncPayload(data: string, sha256: string, length: number): Buffer {
  if (data.length !== length || createHash("sha256").update(data).digest("hex") !== sha256) {
    throw new CloudError(
      `the synced changes don't match their checksum (${data.length}/${length} bytes)`,
      "http",
    );
  }
  return gunzipSync(Buffer.from(data, "base64"));
}

/** The steps of a sync command (split on `&&` and `;`), each of which a recorded run must contain. */
export function syncCommandSteps(command: string): string[] {
  return command
    .split(/\s*(?:&&|;)\s*/)
    .map((step) => step.trim())
    .filter(Boolean);
}
