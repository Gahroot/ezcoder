// Codex cloud tasks (chatgpt.com/codex) through the ChatGPT sign-in EZ Coder
// already holds. Endpoints and shapes follow the openai/codex sources
// (codex-rs/backend-client, cloud-tasks-client/src/http.rs,
// cloud-tasks/src/env_detect.rs):
//   GET  /wham/environments/by-repo/github/<owner>/<repo>, GET /wham/environments
//   POST /wham/tasks  {new_task:{environment_id, branch, run_environment_in_qa_mode},
//                      input_items:[message, pre_apply_patch?]}
//   GET  /wham/tasks/<id>  -> current_user_turn / current_assistant_turn / current_diff_task_turn
//
// Codex clones the repository from GitHub at a branch, so the base commit must
// be on origin; local commits past the branch tip and uncommitted work travel
// as a `pre_apply_patch`.
//
// Limits of the API (as of the sources above):
// - The worklog only carries author roles and text parts, not harness-recorded
//   shell commands with their output, so `commands` is always []: a Codex
//   result can't be verified and must never be trusted for gates.
// - No follow-up, interrupt or archive endpoint exists in the client: send()
//   and interrupt() refuse, archive() is a no-op.
// - Whether the task diff includes the pre_apply_patch is undocumented; diff()
//   detects which base it applies to (see diff()).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AuthStorage } from "../auth-storage.js";
import {
  providerSettings,
  readCloudSettings,
  recordUtilization,
  type CloudSettings,
} from "./config.js";
import { git, githubRepoFromUrl, runGit } from "./git.js";
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

export const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const SIGN_IN_HINT = "Sign in with ChatGPT in EZ Coder";
const SETUP_HINT =
  "Run `ezcoder cloud setup codex` (connects GitHub once, then everything is automatic)";
/** Codex's own page for connecting GitHub (one approval on github.com). */
export const CODEX_CONNECT_URL = "https://chatgpt.com/codex/settings/connectors";
/** The machine image Codex's website uses for its quick "create environment". */
export const CODEX_DEFAULT_MACHINE = "wham-public/wham-universal";

export function codexTaskUrl(id: string): string {
  return `https://chatgpt.com/codex/tasks/${encodeURIComponent(id)}`;
}

function repoAccessHint(repo: string): string {
  return `Give Codex's GitHub app access to ${repo} (${CODEX_CONNECT_URL}), then it's automatic`;
}

interface CodexCredentials {
  accessToken: string;
  accountId?: string;
}

export interface CodexAuth {
  resolveCredentials(
    provider: string,
    opts?: { forceRefresh?: boolean; rejectedToken?: string },
  ): Promise<CodexCredentials>;
}

export interface CodexCloudOptions {
  auth?: CodexAuth;
  fetch?: typeof fetch;
  baseUrl?: string;
  settings?: () => CloudSettings;
  /** Where plan usage goes (default: ~/.ezcoder/cloud/state.json). */
  recordUtilization?: (id: "codex-cloud", value: number, resetsAt?: string) => void;
}

/** GET /wham/usage (the ChatGPT plan's Codex meter), the parts we use. */
interface CodexUsage {
  email?: string;
  plan_type?: string;
  rate_limit?: {
    limit_reached?: boolean;
    primary_window?: { used_percent?: number; reset_at?: number } | null;
  } | null;
}

interface CodexRepository {
  id: string;
  name?: string | null;
  repository_full_name?: string | null;
}

/** The body Codex's website sends for its one-click environment (same defaults). */
export function codexEnvironmentBody(repositoryId: string, label: string): Record<string, unknown> {
  return {
    label,
    machine_id: CODEX_DEFAULT_MACHINE,
    devcontainer: null,
    repos: [repositoryId],
    description: "Created by EZ Coder",
    setup: "",
    maintenance_setup: "",
    workspace_dir: "/workspace",
    agent_network_access: { mode: "off" },
    share_settings: "private",
    share_targets: [],
    env_vars: {},
    secrets: {},
    auto_setup_settings: null,
    cache_settings: { post_setup_cache_enabled: true },
  };
}

interface CodexEnvironment {
  id: string;
  label?: string | null;
  is_pinned?: boolean | null;
  task_count?: number | null;
}

// --- task details (codex-rs/backend-client/src/types.rs) -------------------

type ContentFragment = string | { content_type?: string; text?: string };

interface TurnItem {
  type?: string;
  role?: string;
  content?: ContentFragment[] | null;
  diff?: string | null;
  output_diff?: { diff?: string | null } | null;
}

interface CodexTurn {
  id?: string;
  turn_status?: string;
  input_items?: TurnItem[] | null;
  output_items?: TurnItem[] | null;
  worklog?: {
    messages?: { author?: { role?: string }; content?: { parts?: ContentFragment[] } }[] | null;
  } | null;
  error?: { code?: string; message?: string } | null;
}

export interface CodexTaskDetails {
  task?: { id?: string; title?: string; archived?: boolean };
  current_user_turn?: CodexTurn | null;
  current_assistant_turn?: CodexTurn | null;
  current_diff_task_turn?: CodexTurn | null;
}

function fragmentText(fragment: ContentFragment): string | undefined {
  if (typeof fragment === "string") return fragment.trim() ? fragment : undefined;
  if (fragment?.content_type?.toLowerCase() !== "text") return undefined;
  return fragment.text || undefined;
}

function turnDiff(turn: CodexTurn | null | undefined): string | undefined {
  for (const item of turn?.output_items ?? []) {
    if (item.type === "output_diff" && item.diff) return item.diff;
    if (item.type === "pr" && item.output_diff?.diff) return item.output_diff.diff;
  }
  return undefined;
}

/** The task's unified diff: the diff turn first, then the assistant turn. */
export function codexUnifiedDiff(details: CodexTaskDetails): string | undefined {
  return turnDiff(details.current_diff_task_turn) ?? turnDiff(details.current_assistant_turn);
}

/** Assistant text: output messages, then assistant worklog messages. */
export function codexAssistantMessages(details: CodexTaskDetails): string[] {
  const out: string[] = [];
  for (const turn of [details.current_diff_task_turn, details.current_assistant_turn]) {
    if (!turn) continue;
    for (const item of turn.output_items ?? []) {
      if (item.type !== "message") continue;
      for (const fragment of item.content ?? []) {
        const text = fragmentText(fragment);
        if (text) out.push(text);
      }
    }
    for (const message of turn.worklog?.messages ?? []) {
      if (message.author?.role?.toLowerCase() !== "assistant") continue;
      for (const fragment of message.content?.parts ?? []) {
        const text = fragmentText(fragment);
        if (text) out.push(text);
      }
    }
  }
  return out;
}

function errorSummary(turn: CodexTurn | null | undefined): string | undefined {
  const code = turn?.error?.code ?? "";
  const message = turn?.error?.message ?? "";
  if (code && message) return `${code}: ${message}`;
  return code || message || undefined;
}

function stateOf(turnStatus: string | undefined, hasTurn: boolean): CloudTaskState {
  switch (turnStatus) {
    case "completed":
      return "idle";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "in_progress":
      return "running";
    default:
      return hasTurn && turnStatus === "pending" ? "starting" : hasTurn ? "running" : "starting";
  }
}

/** Map GET /wham/tasks/<id> to a CloudTaskStatus. */
export function codexTaskStatus(details: CodexTaskDetails): CloudTaskStatus {
  const turn = details.current_assistant_turn ?? undefined;
  const state = stateOf(turn?.turn_status, !!turn);
  const messages = codexAssistantMessages(details);
  const error = errorSummary(turn);
  // The worklog has no harness-recorded command + output; see the file header.
  const commands: CloudCommandRecord[] = [];
  return {
    state: error && state === "idle" ? "failed" : state,
    ...(messages.length > 0 && { finalText: messages.join("\n\n") }),
    commands,
    turns: state === "idle" || state === "failed" || state === "cancelled" ? 1 : 0,
    ...(error && { error }),
  };
}

function pickEnvironment(envs: CodexEnvironment[], label?: string): CodexEnvironment | undefined {
  if (envs.length === 0) return undefined;
  if (label) {
    const match = envs.find((e) => (e.label ?? "").toLowerCase() === label.toLowerCase());
    if (match) return match;
  }
  if (envs.length === 1) return envs[0];
  return (
    envs.find((e) => e.is_pinned) ??
    [...envs].sort((a, b) => (b.task_count ?? 0) - (a.task_count ?? 0))[0]
  );
}

const COMMIT_ENV = {
  GIT_AUTHOR_NAME: "EZ Coder",
  GIT_AUTHOR_EMAIL: "ezcoder@localhost",
  GIT_COMMITTER_NAME: "EZ Coder",
  GIT_COMMITTER_EMAIL: "ezcoder@localhost",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};

/** Tree of `base` with `patch` applied (private index), or undefined when it doesn't apply. */
async function treeWithPatch(
  repoRoot: string,
  base: string,
  patch: Buffer,
): Promise<string | undefined> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ez-codex-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(tmp, "index") };
    await git(repoRoot, ["read-tree", base], { env });
    if (patch.length > 0) {
      const applied = await runGit(
        repoRoot,
        ["apply", "--cached", "--binary", "--whitespace=nowarn", "-"],
        { env, input: patch },
      );
      if (applied.code !== 0) return undefined;
    }
    return (await git(repoRoot, ["write-tree"], { env })).trim();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function refExists(repoRoot: string, ref: string): Promise<string | undefined> {
  const r = await runGit(repoRoot, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
  return r.code === 0 ? r.stdout.toString().trim() : undefined;
}

/**
 * The origin branch Codex should clone and its tip: the current (or given)
 * branch when its origin tip is an ancestor of `sha`, else a remote branch
 * containing `sha` (tip == sha first, then the default branch).
 */
export async function codexBranchFor(
  repoRoot: string,
  sha: string,
  preferred?: string,
): Promise<{ branch: string; tip: string }> {
  const current =
    preferred ??
    (await runGit(repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.toString().trim();
  if (current) {
    const tip = await refExists(repoRoot, `refs/remotes/origin/${current}`);
    if (tip) {
      const ancestor = await runGit(repoRoot, ["merge-base", "--is-ancestor", tip, sha]);
      if (ancestor.code === 0) return { branch: current, tip };
    }
  }
  const containing = await runGit(repoRoot, [
    "for-each-ref",
    "--contains",
    sha,
    "--format=%(refname:strip=3) %(objectname)",
    "refs/remotes/origin/",
  ]);
  const branches = containing.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim().split(" "))
    .filter((parts): parts is [string, string] => parts.length === 2 && parts[0] !== "HEAD")
    .map(([branch, tip]) => ({ branch, tip }));
  if (branches.length === 0) {
    throw new CloudError(
      `Commit ${sha.slice(0, 12)} is not on origin yet, and Codex cloud clones from GitHub. ` +
        "Push it first (git push).",
      "not_allowed",
    );
  }
  const defaultBranch = (
    await runGit(repoRoot, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"])
  ).stdout
    .toString()
    .trim()
    .replace(/^origin\//, "");
  return (
    branches.find((b) => b.tip === sha) ??
    branches.find((b) => b.branch === defaultBranch) ??
    branches[0]!
  );
}

export class CodexCloudProvider implements CloudProvider {
  readonly id = "codex-cloud" as const;
  private readonly auth: CodexAuth;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly settings: () => CloudSettings;

  constructor(options: CodexCloudOptions = {}) {
    this.auth = options.auth ?? (new AuthStorage() as unknown as CodexAuth);
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
    this.baseUrl = (options.baseUrl ?? CODEX_BASE_URL).replace(/\/+$/, "");
    this.settings = options.settings ?? (() => readCloudSettings());
    this.record = options.recordUtilization ?? recordUtilization;
  }

  private readonly record: NonNullable<CodexCloudOptions["recordUtilization"]>;

  /**
   * The plan's weekly Codex meter, recorded so the cloud plan cap applies to
   * Codex too. Best effort: undefined when the endpoint isn't there.
   */
  private async planUsage(): Promise<{ account: string; limitedUntil?: string } | undefined> {
    let usage: CodexUsage;
    try {
      usage = await this.request<CodexUsage>("GET", "/wham/usage");
    } catch {
      return undefined;
    }
    const window = usage?.rate_limit?.primary_window;
    const resetsAt =
      typeof window?.reset_at === "number"
        ? new Date(window.reset_at * 1000).toISOString()
        : undefined;
    if (typeof window?.used_percent === "number") {
      this.record(this.id, Math.min(1, Math.max(0, window.used_percent / 100)), resetsAt);
    }
    const plan = usage?.plan_type
      ? ` (${usage.plan_type[0]!.toUpperCase()}${usage.plan_type.slice(1)})`
      : "";
    return {
      account: `${usage?.email ?? "ChatGPT"}${plan}`,
      ...(usage?.rate_limit?.limit_reached && { limitedUntil: resetsAt ?? "" }),
    };
  }

  /** True when ChatGPT has no GitHub connection (Codex can't clone anything). */
  private async githubMissing(): Promise<boolean> {
    try {
      await this.request("GET", "/wham/github/installations");
      return false;
    } catch (error) {
      return error instanceof CloudError && /GitHub connection not found/i.test(error.message);
    }
  }

  private async credentials(rejected?: string): Promise<CodexCredentials> {
    let creds: CodexCredentials;
    try {
      creds = await this.auth.resolveCredentials(
        "openai",
        rejected ? { forceRefresh: true, rejectedToken: rejected } : undefined,
      );
    } catch {
      throw new CloudError("Not signed in with ChatGPT", "not_signed_in");
    }
    // An API key has no ChatGPT account: Codex cloud needs the sign-in.
    if (!creds?.accessToken || !creds.accountId) {
      throw new CloudError("Not signed in with ChatGPT", "not_signed_in");
    }
    return creds;
  }

  /** One backend call; retries once with a refreshed token on 401. */
  private async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    let creds = await this.credentials();
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${route}`, {
          method,
          headers: {
            Authorization: `Bearer ${creds.accessToken}`,
            "ChatGPT-Account-Id": creds.accountId!,
            "User-Agent": "codex-cli",
            originator: "codex_cli_rs",
            ...(body !== undefined && { "content-type": "application/json" }),
          },
          ...(body !== undefined && { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(2 * 60_000),
        });
      } catch (error) {
        throw new CloudError(
          `Codex cloud is unreachable: ${error instanceof Error ? error.message : String(error)}`,
          "unreachable",
        );
      }
      if (res.status === 401 && attempt === 0) {
        creds = await this.credentials(creds.accessToken);
        continue;
      }
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      if (res.ok) return parsed as T;
      const detail = (parsed as { detail?: unknown } | undefined)?.detail;
      const detailObj =
        detail && typeof detail === "object" ? (detail as { type?: string; message?: string }) : {};
      const reason =
        (typeof detail === "string" ? detail : detailObj.message) ?? `HTTP ${res.status}`;
      const code =
        res.status === 401 || res.status === 403
          ? "not_signed_in"
          : res.status === 404
            ? "not_found"
            : res.status === 429
              ? "usage_limited"
              : detailObj.type === "environment_repo_access_failed"
                ? "no_environment"
                : "http";
      throw new CloudError(`Codex cloud: ${reason}`, code, res.status);
    }
  }

  async detect(project?: { repoRoot?: string; repo?: string }): Promise<CloudAvailability> {
    const base = { id: this.id } as const;
    try {
      await this.credentials();
    } catch {
      return {
        ...base,
        available: false,
        detail: "not signed in with ChatGPT",
        setupHint: SIGN_IN_HINT,
      };
    }
    const usage = await this.planUsage();
    const account = usage?.account ?? "ChatGPT";
    if (usage?.limitedUntil !== undefined) {
      return {
        ...base,
        available: false,
        account,
        ...(usage.limitedUntil && { limitedUntil: usage.limitedUntil }),
        detail: "Codex plan limit reached",
      };
    }
    const configured = providerSettings(this.settings(), this.id).environment;
    if (configured) {
      return {
        ...base,
        available: true,
        account,
        environmentId: configured,
        detail: `ready (environment ${configured} from cloud.json)`,
      };
    }
    let repo = project?.repo;
    if (!repo && project?.repoRoot) {
      const origin = await runGit(project.repoRoot, ["remote", "get-url", "origin"]).catch(
        () => undefined,
      );
      if (origin?.code === 0) repo = githubRepoFromUrl(origin.stdout.toString());
    }
    try {
      const found = await this.findEnvironment(repo, { create: false });
      if (found.kind === "env") {
        const env = found.env;
        return {
          ...base,
          available: true,
          account,
          environmentId: env.id,
          ...(env.label && { environmentName: env.label }),
          detail: `ready (environment ${env.label ?? env.id})`,
        };
      }
      if (found.kind === "creatable") {
        // Connected and the repo is visible: the environment is made on first use.
        return {
          ...base,
          available: true,
          account,
          detail: `ready (an environment for ${found.repo} is created on first use)`,
        };
      }
      return { ...base, available: false, account, detail: found.detail, setupHint: found.hint };
    } catch (error) {
      if (error instanceof CloudError && error.code === "not_signed_in") {
        return { ...base, available: false, detail: error.message, setupHint: SIGN_IN_HINT };
      }
      return {
        ...base,
        available: false,
        account,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Is GitHub connected to Codex? (ChatGPT's GitHub connector link.) */
  async githubConnected(): Promise<boolean> {
    return !(await this.githubMissing());
  }

  /** The repository as Codex's GitHub app sees it, or undefined. */
  private async findRepository(repo: string): Promise<CodexRepository | undefined> {
    const name = repo.split("/")[1] ?? repo;
    const raw = await this.request<unknown>(
      "GET",
      `/wham/github/repositories/search/all-installations?query=${encodeURIComponent(name)}&limit=50&page=1`,
    );
    const obj = raw as { repositories?: unknown; items?: unknown } | undefined;
    const list = (
      Array.isArray(raw) ? raw : Array.isArray(obj?.repositories) ? obj.repositories : obj?.items
    ) as CodexRepository[] | undefined;
    return (list ?? []).find(
      (r) => r?.id && (r.repository_full_name ?? "").toLowerCase() === repo.toLowerCase(),
    );
  }

  private async environmentsFor(repo: string | undefined): Promise<CodexEnvironment[]> {
    if (!repo) {
      // No GitHub repo known: Codex's own fallback, the full list.
      const all = await this.request<CodexEnvironment[]>("GET", "/wham/environments");
      return Array.isArray(all) ? all : [];
    }
    const [owner, name] = repo.split("/");
    try {
      const envs = await this.request<CodexEnvironment[]>(
        "GET",
        `/wham/environments/by-repo/github/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}`,
      );
      return Array.isArray(envs) ? envs : [];
    } catch (error) {
      if (error instanceof CloudError && error.code === "no_environment") return [];
      throw error;
    }
  }

  /**
   * The environment for `repo`, creating it (Codex's website defaults: its
   * universal image, agent internet off, private) when `create` is set and
   * Codex can see the repo. Never creates one for a repo Codex can't access.
   */
  async findEnvironment(
    repo: string | undefined,
    options: { create: boolean },
  ): Promise<
    | { kind: "env"; env: CodexEnvironment; created?: boolean }
    | { kind: "creatable"; repo: string }
    | { kind: "missing"; detail: string; hint: string }
  > {
    const env = pickEnvironment(await this.environmentsFor(repo));
    if (env) return { kind: "env", env };
    if (await this.githubMissing()) {
      return { kind: "missing", detail: "GitHub isn't connected to Codex yet", hint: SETUP_HINT };
    }
    if (!repo) {
      return {
        kind: "missing",
        detail: "this folder has no GitHub repository for Codex",
        hint: "Codex cloud works on GitHub repositories",
      };
    }
    const found = await this.findRepository(repo);
    if (!found) {
      return {
        kind: "missing",
        detail: `Codex's GitHub app can't see ${repo}`,
        hint: repoAccessHint(repo),
      };
    }
    if (!options.create) return { kind: "creatable", repo };
    const labels = [found.name || repo.split("/")[1] || repo, repo];
    for (const label of labels) {
      try {
        const created = await this.request<CodexEnvironment>(
          "POST",
          "/wham/environments",
          codexEnvironmentBody(found.id, label),
        );
        if (created?.id) return { kind: "env", env: created, created: true };
      } catch (error) {
        // Same label already used (another owner's repo of the same name, or a
        // race with another EZ Coder): look again, then try the full name.
        if (!(error instanceof CloudError && /already exists/i.test(error.message))) throw error;
        const again = pickEnvironment(await this.environmentsFor(repo));
        if (again) return { kind: "env", env: again };
      }
    }
    throw new CloudError(`Codex cloud: couldn't create an environment for ${repo}`, "http");
  }

  async start(request: CloudTaskRequest): Promise<CloudTaskHandle> {
    const { source } = request;
    if (!source.repo) {
      throw new CloudError(
        "Codex cloud clones from GitHub, and this project has no GitHub origin.",
        "not_allowed",
      );
    }
    let availability = await this.detect({ repoRoot: source.repoRoot, repo: source.repo });
    if (availability.available && !availability.environmentId) {
      // Auto-managed: make this repo's environment now, once.
      const made = await this.findEnvironment(source.repo, { create: true });
      if (made.kind === "env") {
        availability = { ...availability, environmentId: made.env.id };
      } else {
        availability = {
          ...availability,
          available: false,
          detail: made.kind === "missing" ? made.detail : "no environment",
          ...(made.kind === "missing" && { setupHint: made.hint }),
        };
      }
    }
    if (!availability.available || !availability.environmentId) {
      throw new CloudError(
        `Codex cloud can't take this task: ${availability.detail}` +
          (availability.setupHint ? `. ${availability.setupHint}.` : ""),
        availability.setupHint === SIGN_IN_HINT ? "not_signed_in" : "no_environment",
      );
    }
    const { repoRoot, sha } = source;
    const { branch, tip } = await codexBranchFor(repoRoot, sha, source.branch);
    const shaTree = (await git(repoRoot, ["rev-parse", `${sha}^{tree}`])).trim();
    const startTree = source.patch?.length
      ? await treeWithPatch(repoRoot, sha, source.patch)
      : shaTree;
    if (!startTree) throw new Error("The uncommitted changes don't apply to HEAD");
    // Local commits past the branch tip + uncommitted work, as one patch.
    const prePatch = (
      await runGit(repoRoot, [
        "-c",
        "core.quotepath=false",
        "diff",
        "--binary",
        "--full-index",
        "--no-ext-diff",
        "--no-color",
        tip,
        startTree,
      ])
    ).stdout;
    // A local commit with the start tree, parented on the branch tip.
    const baseCommit = (
      await git(repoRoot, ["commit-tree", startTree, "-p", tip, "-m", `ez codex start ${sha}`], {
        env: { ...process.env, ...COMMIT_ENV },
      })
    ).trim();
    const inputItems: unknown[] = [
      { type: "message", role: "user", content: [{ content_type: "text", text: request.prompt }] },
    ];
    if (prePatch.length > 0) {
      inputItems.push({
        type: "pre_apply_patch",
        output_diff: { diff: prePatch.toString("utf-8") },
      });
    }
    const created = await this.request<{ task?: { id?: string }; id?: string }>(
      "POST",
      "/wham/tasks",
      {
        new_task: {
          environment_id: availability.environmentId,
          branch,
          run_environment_in_qa_mode: false,
        },
        input_items: inputItems,
      },
    );
    const id = created?.task?.id ?? created?.id;
    if (!id) throw new CloudError("Codex cloud returned no task id", "http");
    return {
      provider: this.id,
      id,
      url: codexTaskUrl(id),
      baseTree: startTree,
      baseCommit,
      repoRoot,
    };
  }

  private details(handle: CloudTaskHandle): Promise<CodexTaskDetails> {
    return this.request<CodexTaskDetails>("GET", `/wham/tasks/${encodeURIComponent(handle.id)}`);
  }

  async status(handle: CloudTaskHandle): Promise<CloudTaskStatus> {
    return codexTaskStatus(await this.details(handle));
  }

  async send(): Promise<void> {
    throw new CloudError(
      "Codex cloud tasks can't take follow-up messages from EZ Coder (no follow-up API); start a new task.",
      "not_allowed",
    );
  }

  /**
   * The task's changes against its start tree. Codex reports a diff against
   * either the cloned branch tip or the tree after the pre_apply_patch; it
   * applies cleanly to only one of them, so try the start tree first, then
   * the tip, and re-diff against the start tree.
   */
  async diff(handle: CloudTaskHandle): Promise<Buffer> {
    const raw = codexUnifiedDiff(await this.details(handle));
    if (!raw) return Buffer.alloc(0);
    const { repoRoot, baseCommit } = handle;
    if (!repoRoot || !baseCommit) {
      throw new CloudError("This Codex task has no local base to diff against", "not_allowed");
    }
    const patch = Buffer.from(raw.endsWith("\n") ? raw : `${raw}\n`, "utf-8");
    const after =
      (await treeWithPatch(repoRoot, baseCommit, patch)) ??
      (await treeWithPatch(repoRoot, `${baseCommit}^`, patch));
    if (!after) {
      throw new CloudError(
        `Codex's diff doesn't apply to the code the task started from; see ${handle.url}`,
        "http",
      );
    }
    return (
      await runGit(repoRoot, [
        "-c",
        "core.quotepath=false",
        "diff",
        "--binary",
        "--no-ext-diff",
        "--no-color",
        baseCommit,
        after,
      ])
    ).stdout;
  }

  async interrupt(): Promise<void> {
    throw new CloudError("Codex cloud tasks can't be interrupted from EZ Coder", "not_allowed");
  }

  /** No archive endpoint in the Codex client; the task stays in the user's list. */
  async archive(): Promise<void> {}
}
