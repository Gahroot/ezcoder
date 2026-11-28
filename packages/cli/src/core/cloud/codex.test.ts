import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexCloudProvider,
  codexAssistantMessages,
  codexTaskStatus,
  codexUnifiedDiff,
  type CodexAuth,
  type CodexTaskDetails,
} from "./codex.js";
import { CloudError } from "./types.js";

const fixture = (name: string): CodexTaskDetails =>
  JSON.parse(
    fs.readFileSync(new URL(`./__fixtures__/${name}.json`, import.meta.url), "utf-8"),
  ) as CodexTaskDetails;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

/** A clone of a bare origin with a.txt on main. */
function makeRepo(): { local: string; tip: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ez-codex-test-")));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  fs.mkdirSync(seed);
  sh(root, "init", "-q", "--bare", "-b", "main", origin);
  sh(seed, "init", "-q", "-b", "main");
  for (const dir of [seed]) {
    sh(dir, "config", "user.email", "t@example.com");
    sh(dir, "config", "user.name", "Test");
    sh(dir, "config", "commit.gpgsign", "false");
  }
  fs.writeFileSync(path.join(seed, "a.txt"), "a\n");
  sh(seed, "add", "-A");
  sh(seed, "commit", "-q", "-m", "init");
  sh(seed, "push", "-q", origin, "main");
  const local = path.join(root, "local");
  sh(root, "clone", "-q", origin, local);
  sh(local, "config", "user.email", "t@example.com");
  sh(local, "config", "user.name", "Test");
  sh(local, "config", "commit.gpgsign", "false");
  return { local, tip: sh(local, "rev-parse", "HEAD").trim() };
}

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

function fakeFetch(routes: Record<string, (call: Call) => [number, unknown]>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      headers: init?.headers as Record<string, string>,
      ...(init?.body !== undefined && { body: JSON.parse(String(init.body)) }),
    };
    calls.push(call);
    const route = Object.keys(routes).find((key) => url.endsWith(key) || url.includes(`${key}?`));
    const [status, body] = route ? routes[route]!(call) : [404, { detail: "Not found" }];
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const signedIn: CodexAuth = {
  resolveCredentials: async () => ({ accessToken: "tok", accountId: "acct" }),
};

function provider(fetchImpl: typeof fetch, auth = signedIn, environment?: string) {
  return new CodexCloudProvider({
    auth,
    fetch: fetchImpl,
    settings: () => (environment ? { providers: { "codex-cloud": { environment } } } : {}),
  });
}

describe("Codex task details mapping (openai/codex fixtures)", () => {
  it("extracts the diff, assistant text and a finished status", () => {
    const details = fixture("codex-task-details-with-diff");
    expect(codexUnifiedDiff(details)).toContain("diff --git a/src/main.rs");
    expect(codexAssistantMessages(details)).toEqual(["Assistant response"]);
    // No turn_status in the fixture: still in progress as far as we know.
    expect(codexTaskStatus(details)).toMatchObject({ state: "running", turns: 0, commands: [] });
  });

  it("maps a completed turn to idle, with no commands (the worklog has none)", () => {
    const details: CodexTaskDetails = {
      current_assistant_turn: {
        turn_status: "completed",
        output_items: [{ type: "message", content: [{ content_type: "text", text: "All done" }] }],
        worklog: {
          messages: [
            { author: { role: "tool" }, content: { parts: ["$ npm test\nok"] } },
            { author: { role: "assistant" }, content: { parts: ["Ran the tests"] } },
          ],
        },
      },
    };
    expect(codexTaskStatus(details)).toEqual({
      state: "idle",
      finalText: "All done\n\nRan the tests",
      commands: [],
      turns: 1,
    });
  });

  it("maps errors and the pr output diff", () => {
    const details = fixture("codex-task-details-with-error");
    expect(codexUnifiedDiff(details)).toContain("lib.rs");
    const status = codexTaskStatus(details);
    expect(status.error).toBe("APPLY_FAILED: Patch could not be applied");
    expect(codexTaskStatus({ current_assistant_turn: { turn_status: "failed" } }).state).toBe(
      "failed",
    );
    expect(codexTaskStatus({ current_assistant_turn: { turn_status: "cancelled" } }).state).toBe(
      "cancelled",
    );
    expect(codexTaskStatus({}).state).toBe("starting");
  });
});

describe("CodexCloudProvider.detect", () => {
  it("is unavailable with a sign-in hint when not signed in with ChatGPT", async () => {
    const { fetch, calls } = fakeFetch({});
    const apiKeyOnly: CodexAuth = { resolveCredentials: async () => ({ accessToken: "sk-x" }) };
    for (const auth of [
      apiKeyOnly,
      {
        resolveCredentials: async () => {
          throw new Error("Not logged in");
        },
      },
    ]) {
      const a = await provider(fetch, auth).detect({ repo: "o/r" });
      expect(a).toMatchObject({ available: false, setupHint: "Sign in with ChatGPT in EZ Coder" });
    }
    expect(calls).toHaveLength(0);
  });

  it("tells the user to connect GitHub when Codex can't access the repo", async () => {
    const { fetch, calls } = fakeFetch({
      "/wham/environments/by-repo/github/o/r": () => [
        400,
        {
          detail: {
            type: "environment_repo_access_failed",
            message: "Codex can’t access this repository.",
          },
        },
      ],
      "/wham/github/installations": () => [200, []],
      "/wham/github/repositories/search/all-installations": () => [200, { repositories: [] }],
    });
    const a = await provider(fetch).detect({ repo: "o/r" });
    expect(a.available).toBe(false);
    expect(a.detail).toBe("Codex's GitHub app can't see o/r");
    expect(a.setupHint).toContain("chatgpt.com/codex");
    expect(a.setupHint).toContain("o/r");
    expect(calls[0]!.headers).toMatchObject({
      Authorization: "Bearer tok",
      "ChatGPT-Account-Id": "acct",
      originator: "codex_cli_rs",
    });
  });

  it("picks the repo's environment, or the configured one", async () => {
    const { fetch } = fakeFetch({
      "/wham/environments/by-repo/github/o/r": () => [
        200,
        [
          { id: "env_a", label: "a", task_count: 1 },
          { id: "env_b", label: "b", is_pinned: true },
        ],
      ],
      "/wham/environments": () => [200, []],
    });
    expect(await provider(fetch).detect({ repo: "o/r" })).toMatchObject({
      available: true,
      environmentId: "env_b",
    });
    expect(await provider(fetch).detect({})).toMatchObject({
      available: false,
      detail: "this folder has no GitHub repository for Codex",
    });
    expect(await provider(fetch, signedIn, "env_x").detect({ repo: "o/r" })).toMatchObject({
      available: true,
      environmentId: "env_x",
    });
  });

  it("retries once with a refreshed token on 401", async () => {
    let n = 0;
    const auth: CodexAuth = {
      resolveCredentials: async (_p, opts) => ({
        accessToken: opts?.forceRefresh ? "fresh" : "stale",
        accountId: "acct",
      }),
    };
    const { fetch, calls } = fakeFetch({
      "/wham/environments": (call) =>
        n++ === 0 || call.headers.Authorization !== "Bearer fresh"
          ? [401, {}]
          : [200, [{ id: "e" }]],
    });
    expect(await provider(fetch, auth).detect()).toMatchObject({ available: true });
    const envCalls = calls.filter((c) => c.url.endsWith("/wham/environments"));
    expect(envCalls.map((c) => c.headers.Authorization)).toEqual(["Bearer stale", "Bearer fresh"]);
  });
});

describe("CodexCloudProvider tasks", () => {
  const envRoutes = {
    "/wham/environments/by-repo/github/o/r": (): [number, unknown] => [200, [{ id: "env_1" }]],
  };

  it("starts from the origin branch with local commits + uncommitted work as pre_apply_patch", async () => {
    const { local, tip } = makeRepo();
    fs.writeFileSync(path.join(local, "a.txt"), "a\ncommitted\n");
    sh(local, "commit", "-q", "-am", "local only");
    const sha = sh(local, "rev-parse", "HEAD").trim();
    fs.writeFileSync(path.join(local, "new.txt"), "uncommitted\n");
    sh(local, "add", "-N", "new.txt");
    const patch = execFileSync("git", ["diff", "--binary", sha], { cwd: local });
    const { fetch, calls } = fakeFetch({
      ...envRoutes,
      "/wham/tasks": () => [200, { task: { id: "task_e_1" } }],
    });
    const handle = await provider(fetch).start({
      title: "t",
      prompt: "do it",
      source: { repoRoot: local, repo: "o/r", sha, patch, branch: "main" },
    });
    expect(handle).toMatchObject({
      provider: "codex-cloud",
      id: "task_e_1",
      url: "https://chatgpt.com/codex/tasks/task_e_1",
      repoRoot: local,
    });
    expect(sh(local, "rev-parse", `${handle.baseCommit}^`).trim()).toBe(tip);
    const body = calls.find((c) => c.method === "POST")!.body as {
      new_task: Record<string, unknown>;
      input_items: { type: string; output_diff?: { diff: string } }[];
    };
    expect(body.new_task).toEqual({
      environment_id: "env_1",
      branch: "main",
      run_environment_in_qa_mode: false,
    });
    expect(body.input_items[0]).toMatchObject({
      type: "message",
      role: "user",
      content: [{ content_type: "text", text: "do it" }],
    });
    const pre = body.input_items[1]!.output_diff!.diff;
    expect(pre).toContain("+committed");
    expect(pre).toContain("+uncommitted");
    // The patch rebuilds the start tree from the branch tip.
    const env = { ...process.env, GIT_INDEX_FILE: path.join(local, ".git", "verify-index") };
    execFileSync("git", ["read-tree", tip], { cwd: local, env });
    execFileSync("git", ["apply", "--cached", "-"], { cwd: local, env, input: pre });
    expect(execFileSync("git", ["write-tree"], { cwd: local, env, encoding: "utf-8" }).trim()).toBe(
      handle.baseTree,
    );
  });

  it("refuses work whose base is not on origin, or with no GitHub repo", async () => {
    const { local } = makeRepo();
    sh(local, "checkout", "-q", "-b", "feature");
    sh(local, "commit", "-q", "--allow-empty", "-m", "unpushed");
    sh(local, "checkout", "-q", "--orphan", "lonely");
    sh(local, "commit", "-q", "--allow-empty", "-m", "orphan");
    const sha = sh(local, "rev-parse", "HEAD").trim();
    const { fetch } = fakeFetch(envRoutes);
    await expect(
      provider(fetch).start({
        title: "t",
        prompt: "p",
        source: { repoRoot: local, repo: "o/r", sha },
      }),
    ).rejects.toThrow(/not on origin/);
    await expect(
      provider(fetch).start({ title: "t", prompt: "p", source: { repoRoot: local, sha } }),
    ).rejects.toThrow(/GitHub/);
  });

  it("re-bases Codex's diff onto the start tree whichever base it was taken against", async () => {
    const { local, tip } = makeRepo();
    fs.writeFileSync(path.join(local, "local.txt"), "mine\n");
    sh(local, "add", "-N", "local.txt");
    const patch = execFileSync("git", ["diff", "--binary", tip], { cwd: local });
    let diff = "";
    const { fetch } = fakeFetch({
      ...envRoutes,
      "/wham/tasks": () => [200, { id: "task_e_2" }],
      "/wham/tasks/task_e_2": () => [
        200,
        { current_diff_task_turn: { output_items: [{ type: "output_diff", diff }] } },
      ],
    });
    const p = provider(fetch);
    const handle = await p.start({
      title: "t",
      prompt: "p",
      source: { repoRoot: local, repo: "o/r", sha: tip, patch },
    });
    const codexOnly =
      "diff --git a/b.txt b/b.txt\nnew file mode 100644\n--- /dev/null\n+++ b/b.txt\n@@ -0,0 +1 @@\n+codex\n";
    const withPre =
      codexOnly +
      "diff --git a/local.txt b/local.txt\nnew file mode 100644\n--- /dev/null\n+++ b/local.txt\n@@ -0,0 +1 @@\n+mine\n";
    for (const raw of [codexOnly, withPre]) {
      diff = raw;
      const out = (await p.diff(handle)).toString();
      expect(out).toContain("b/b.txt");
      expect(out).toContain("+codex");
      expect(out).not.toContain("local.txt");
    }
    diff = "";
    expect((await p.diff(handle)).length).toBe(0);
  });

  it("has no follow-up or interrupt endpoint; archive is a no-op", async () => {
    const { fetch, calls } = fakeFetch({});
    const p = provider(fetch);
    const handle = { provider: "codex-cloud" as const, id: "t", url: "u" };
    await expect(p.send()).rejects.toBeInstanceOf(CloudError);
    await expect(p.interrupt()).rejects.toMatchObject({ code: "not_allowed" });
    await p.archive();
    expect(handle.id).toBe("t");
    expect(calls).toHaveLength(0);
  });
});

describe("Codex plan usage and GitHub connection", () => {
  it("records the weekly meter, shows the account and names the missing GitHub link", async () => {
    const recorded: Array<[string, number, string | undefined]> = [];
    const { fetch } = fakeFetch({
      "/wham/usage": () => [
        200,
        {
          email: "me@example.com",
          plan_type: "pro",
          rate_limit: {
            limit_reached: false,
            primary_window: { used_percent: 5, reset_at: 1800000000 },
          },
        },
      ],
      "/wham/environments": () => [200, []],
      "/wham/github/installations": () => [
        400,
        {
          detail: {
            type: "missing_github_connector_link",
            message: "GitHub connection not found for user",
          },
        },
      ],
    });
    const p = new CodexCloudProvider({
      auth: signedIn,
      fetch,
      settings: () => ({}),
      recordUtilization: (id, value, resetsAt) => recorded.push([id, value, resetsAt]),
    });
    const a = await p.detect();
    expect(a.available).toBe(false);
    expect(a.account).toBe("me@example.com (Pro)");
    expect(a.detail).toMatch(/GitHub isn't connected/);
    expect(a.setupHint).toMatch(/ezcoder cloud setup codex/);
    expect(recorded).toEqual([["codex-cloud", 0.05, new Date(1800000000 * 1000).toISOString()]]);
  });

  it("is unavailable when the Codex plan limit is reached", async () => {
    const { fetch } = fakeFetch({
      "/wham/usage": () => [
        200,
        {
          rate_limit: {
            limit_reached: true,
            primary_window: { used_percent: 100, reset_at: 1800000000 },
          },
        },
      ],
    });
    const p = new CodexCloudProvider({
      auth: signedIn,
      fetch,
      settings: () => ({}),
      recordUtilization: () => {},
    });
    const a = await p.detect();
    expect(a.available).toBe(false);
    expect(a.detail).toMatch(/limit/);
    expect(a.limitedUntil).toBe(new Date(1800000000 * 1000).toISOString());
  });
});

describe("Codex environments are auto-managed", () => {
  function routes(over: Record<string, (call: Call) => [number, unknown]> = {}) {
    let created: unknown;
    const { fetch, calls } = fakeFetch({
      "/wham/usage": () => [200, {}],
      "/wham/environments/by-repo/github/o/r": () => (created ? [200, [created]] : [200, []]),
      "/wham/github/installations": () => [200, []],
      "/wham/github/repositories/search/all-installations": () => [
        200,
        {
          repositories: [
            { id: "github-9", name: "r", repository_full_name: "other/r" },
            { id: "github-7", name: "r", repository_full_name: "o/r" },
          ],
        },
      ],
      "/wham/environments": (call) => {
        if (call.method !== "POST") return [200, []];
        created = { id: "env_new", label: (call.body as { label: string }).label };
        return [200, created];
      },
      ...over,
    });
    return { fetch, calls };
  }

  it("reports a visible repo as ready, without creating anything", async () => {
    const { fetch, calls } = routes();
    const a = await provider(fetch).detect({ repo: "o/r" });
    expect(a).toMatchObject({ available: true });
    expect(a.environmentId).toBeUndefined();
    expect(a.detail).toMatch(/created on first use/);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("creates the environment with the website's defaults for the exact repo, once", async () => {
    const { fetch, calls } = routes();
    const p = provider(fetch);
    const made = await p.findEnvironment("o/r", { create: true });
    expect(made).toMatchObject({ kind: "env", env: { id: "env_new" }, created: true });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({
      label: "r",
      machine_id: "wham-public/wham-universal",
      repos: ["github-7"],
      agent_network_access: { mode: "off" },
      share_settings: "private",
      workspace_dir: "/workspace",
    });
    // Next time it's found, not created again.
    expect(await p.findEnvironment("o/r", { create: true })).toMatchObject({
      kind: "env",
      env: { id: "env_new" },
    });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("falls back to the full name when the short label is taken", async () => {
    const labels: string[] = [];
    const { fetch } = routes({
      "/wham/environments": (call) => {
        if (call.method !== "POST") return [200, []];
        const label = (call.body as { label: string }).label;
        labels.push(label);
        return label === "r"
          ? [400, { detail: "Environment with this label already exists" }]
          : [200, { id: "env_full", label }];
      },
    });
    const made = await provider(fetch).findEnvironment("o/r", { create: true });
    expect(made).toMatchObject({ kind: "env", env: { id: "env_full" } });
    expect(labels).toEqual(["r", "o/r"]);
  });

  it("never creates one while GitHub isn't connected", async () => {
    const { fetch, calls } = routes({
      "/wham/github/installations": () => [
        400,
        {
          detail: {
            type: "missing_github_connector_link",
            message: "GitHub connection not found for user",
          },
        },
      ],
    });
    const made = await provider(fetch).findEnvironment("o/r", { create: true });
    expect(made).toMatchObject({ kind: "missing", detail: "GitHub isn't connected to Codex yet" });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});
