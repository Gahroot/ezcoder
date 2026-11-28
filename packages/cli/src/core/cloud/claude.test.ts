import { describe, expect, it, vi } from "vitest";
import { ClaudeCloudProvider, type ClaudeCloudDeps } from "./claude.js";
import { CloudError, type CloudTaskHandle } from "./types.js";

type Route = (url: URL, init: RequestInit) => { status?: number; body?: unknown } | undefined;

const PROFILE = {
  account: { email: "me@x.com", has_claude_max: true },
  organization: { uuid: "org-1" },
};
const ENVS = {
  environments: [
    { kind: "anthropic_cloud", environment_id: "env_other", name: "Other", state: "active" },
    { kind: "anthropic_cloud", environment_id: "env_def", name: "Default", state: "active" },
  ],
};

function setup(routes: Route[] = [], o: Partial<ClaudeCloudDeps> = {}) {
  const calls: { method: string; url: URL; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ method: init.method ?? "GET", url, init });
    for (const r of routes) {
      const hit = r(url, init);
      if (hit) {
        return new Response(JSON.stringify(hit.body ?? {}), { status: hit.status ?? 200 });
      }
    }
    if (url.pathname === "/api/oauth/profile") return Response.json(PROFILE);
    if (url.pathname === "/v1/environment_providers") return Response.json(ENVS);
    return new Response("not mocked", { status: 500 });
  });
  const auth = {
    resolveCredentials: vi.fn(async (_p: string, opts?: { forceRefresh?: boolean }) => ({
      accessToken: opts?.forceRefresh ? "tok-new" : "tok-old",
    })),
  };
  const deps = {
    fetch: fetchMock as unknown as typeof fetch,
    auth,
    settings: () => ({}),
    recordUtilization: vi.fn(),
    benchProvider: vi.fn(),
    commitSnapshot: vi.fn(async () => ({ tree: "t".repeat(40), commit: "c1", withheld: [] })),
    workingTreeSnapshot: vi.fn(async () => ({ tree: "w".repeat(40), commit: "c2", withheld: [] })),
    bundleOf: vi.fn(async () => Buffer.from("bundle")),
    now: () => 1_000_000,
    ...o,
  };
  return { provider: new ClaudeCloudProvider(deps), calls, deps, auth };
}

const handle: CloudTaskHandle = { provider: "claude-cloud", id: "session_1", url: "" };
const page = (data: unknown[], has_more = false, last_id?: string) => ({
  body: { data, has_more, ...(last_id && { last_id }) },
});
const bash = (id: string, command: string) => ({
  id: `e-${id}`,
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
});
const result = (id: string, text: string) => ({
  id: `r-${id}`,
  type: "user",
  message: {
    content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }],
  },
});

describe("ClaudeCloudProvider", () => {
  it("detects the Default environment and account", async () => {
    const { provider } = setup();
    expect(await provider.detect()).toMatchObject({
      available: true,
      environmentId: "env_def",
      account: "me@x.com (Max)",
    });
  });

  it("is unavailable when not signed in, without a plan, or without an environment", async () => {
    const out = setup();
    out.auth.resolveCredentials.mockRejectedValueOnce(
      Object.assign(new Error("Not logged in"), { name: "NotLoggedInError" }),
    );
    expect(await out.provider.detect()).toMatchObject({
      available: false,
      setupHint: "Sign in to Claude in EZ Coder (/login)",
    });
    const free = setup([
      (u) =>
        u.pathname === "/api/oauth/profile"
          ? { body: { account: { email: "f@x" }, organization: { uuid: "o" } } }
          : undefined,
    ]);
    expect((await free.provider.detect()).available).toBe(false);
    const none = setup([
      (u) =>
        u.pathname === "/v1/environment_providers" ? { body: { environments: [] } } : undefined,
    ]);
    const a = await none.provider.detect();
    expect(a.available).toBe(false);
    expect(a.setupHint).toMatch(/cloud setup/);
    // detect never creates an environment
    expect(none.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("refreshes the sign-in once on 401", async () => {
    let first = true;
    const { provider, auth } = setup([
      (u) => {
        if (u.pathname !== "/api/oauth/profile" || !first) return undefined;
        first = false;
        return { status: 401, body: { error: "expired" } };
      },
    ]);
    expect((await provider.detect()).available).toBe(true);
    expect(auth.resolveCredentials).toHaveBeenCalledWith("anthropic", {
      forceRefresh: true,
      rejectedToken: "tok-old",
    });
  });

  it("starts a session with the bundle, model, limits and timeouts", async () => {
    const { provider, calls } = setup([
      (u) => (u.pathname === "/v1/files" ? { body: { id: "file_1" } } : undefined),
      (u) => (u.pathname === "/v1/sessions" ? { body: { id: "session_9" } } : undefined),
    ]);
    const h = await provider.start({
      title: "t",
      prompt: "run it",
      source: { repoRoot: "/r", sha: "s".repeat(40) },
      model: "claude-haiku-5-5",
      maxTurns: 4,
      disallowedTools: ["Edit"],
      commandTimeoutMinutes: 10,
      approveCommand: "bash -c 'x'",
    });
    expect(h).toMatchObject({
      id: "session_9",
      url: "https://claude.ai/code/session_9",
      baseTree: "t".repeat(40),
      baseCommit: "c1",
      approveCommand: "bash -c 'x'",
    });
    const create = calls.find((c) => c.url.pathname === "/v1/sessions")!;
    const body = JSON.parse(String(create.init.body));
    expect(body.environment_id).toBe("env_def");
    expect(body.session_context).toMatchObject({
      seed_bundle_file_id: "file_1",
      model: "claude-haiku-5-5",
      max_turns: 4,
      disallowed_tools: ["Edit"],
      environment_variables: { BASH_DEFAULT_TIMEOUT_MS: "900000", BASH_MAX_TIMEOUT_MS: "900000" },
    });
    expect(body.events[0].data.message).toEqual({ role: "user", content: "run it" });
    const headers = create.init.headers as Record<string, string>;
    expect(headers["x-organization-uuid"]).toBe("org-1");
  });

  it("throws usage_limited when session create hits a limit", async () => {
    const { provider } = setup([
      (u) => (u.pathname === "/v1/files" ? { body: { id: "file_1" } } : undefined),
      (u) =>
        u.pathname === "/v1/sessions" ? { status: 429, body: { error: "rate_limit" } } : undefined,
    ]);
    const err = await provider
      .start({ title: "t", prompt: "p", source: { repoRoot: "/r", sha: "s" } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudError);
    expect((err as CloudError).code).toBe("usage_limited");
  });

  it("maps events to status, paging with after_id and keeping a cursor", async () => {
    const seen: (string | null)[] = [];
    let sessionStatus = "running";
    let round = 0;
    const { provider } = setup([
      (u) =>
        u.pathname === "/v1/sessions/session_1"
          ? { body: { session_status: sessionStatus } }
          : undefined,
      (u) => {
        if (u.pathname !== "/v1/sessions/session_1/events") return undefined;
        const after = u.searchParams.get("after_id");
        seen.push(after);
        if (round === 0 && !after) return page([bash("tu1", "echo hi")], true, "p1");
        if (round === 0 && after === "p1") return page([result("tu1", "hi\n")], false, "p2");
        if (round === 1 && after === "p2")
          return page([
            { id: "a2", type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
            { id: "r1", type: "result", num_turns: 1, is_error: false },
          ]);
        return page([]);
      },
    ]);
    let s = await provider.status(handle);
    expect(s.state).toBe("running");
    expect(s.commands).toEqual([{ command: "echo hi", output: "hi\n", isError: false }]);
    round = 1;
    sessionStatus = "idle";
    s = await provider.status(handle);
    expect(seen).toEqual([null, "p1", "p2"]);
    expect(s).toMatchObject({ state: "idle", finalText: "done", turns: 1 });
    expect(s.commands).toHaveLength(1);
  });

  it("records utilization and benches the provider on a usage limit", async () => {
    const reset = 2_000_000_000;
    const { provider, deps } = setup([
      (u) =>
        u.pathname === "/v1/sessions/session_1" ? { body: { session_status: "idle" } } : undefined,
      (u) =>
        u.pathname === "/v1/sessions/session_1/events"
          ? page([
              {
                id: "x",
                type: "rate_limit_event",
                rate_limit_info: {
                  status: "rejected",
                  resetsAt: reset,
                  unifiedWindows: { seven_day: { utilization: 1, resetsAt: reset } },
                },
              },
            ])
          : undefined,
    ]);
    const s = await provider.status(handle);
    const iso = new Date(reset * 1000).toISOString();
    expect(s.usage).toEqual({ limited: true, utilization: 1, resetsAt: iso });
    expect(deps.recordUtilization).toHaveBeenCalledWith("claude-cloud", 1, iso);
    expect(deps.benchProvider).toHaveBeenCalledWith("claude-cloud", iso, expect.any(String));
  });

  it("allows only the exact approveCommand at a permission prompt", async () => {
    const posted: unknown[] = [];
    const prompt = (rid: string, tid: string) => ({
      id: `c-${rid}`,
      type: "control_request",
      request_id: rid,
      request: { subtype: "can_use_tool", tool_name: "Bash", tool_use_id: tid },
    });
    const { provider } = setup([
      (u) =>
        u.pathname === "/v1/sessions/session_1"
          ? { body: { session_status: "requires_action" } }
          : undefined,
      (u, init) => {
        if (u.pathname !== "/v1/sessions/session_1/events") return undefined;
        if (init.method === "POST") {
          posted.push(JSON.parse(String(init.body)));
          return { body: {} };
        }
        return u.searchParams.get("after_id")
          ? page([])
          : page(
              [
                bash("t1", "RUN"),
                prompt("req1", "t1"),
                bash("t2", "rm -rf x"),
                prompt("req2", "t2"),
              ],
              false,
              "z",
            );
      },
    ]);
    const s = await provider.status({ ...handle, approveCommand: "RUN" });
    expect(s.state).toBe("running");
    const responses = posted.map(
      (p) =>
        (p as { events: { response: { request_id: string; response: unknown } }[] }).events[0]!
          .response,
    );
    expect(responses).toEqual([
      {
        subtype: "success",
        request_id: "req1",
        response: { behavior: "allow", updatedInput: { command: "RUN" }, toolUseID: "t1" },
      },
      {
        subtype: "success",
        request_id: "req2",
        response: { behavior: "deny", message: "Only the given command may run." },
      },
    ]);
    // Answered once only.
    await provider.status({ ...handle, approveCommand: "RUN" });
    expect(posted).toHaveLength(2);
  });
});
