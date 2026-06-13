/**
 * gg-app sidecar — bridges the full ggcoder AgentSession to the Tauri webview
 * over plain HTTP + Server-Sent Events (zero browser-side dependencies).
 *
 * Transport:
 *   GET  /state    → { provider, model, cwd, ready }
 *   GET  /events   → text/event-stream of forwarded agent + session events
 *   POST /prompt   → { text } ; runs AgentSession.prompt(text)
 *   POST /cancel   → aborts the in-flight run
 *
 * The agent spine (gg-ai → gg-agent → gg-core) and every tool are reused
 * unchanged via AgentSession — this file is only a network seam.
 */
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { AgentSession } from "./core/agent-session.js";
import { AuthStorage } from "./core/auth-storage.js";
import { ensureAppDirs, loadSavedSettings } from "./config.js";
import { getDefaultModel, getModel, getMaxThinkingLevel } from "./core/model-registry.js";
import { initLogger, log } from "./core/logger.js";

const ALL_PROVIDERS: Provider[] = [
  "anthropic",
  "xiaomi",
  "openai",
  "gemini",
  "glm",
  "moonshot",
  "minimax",
  "deepseek",
  "openrouter",
];

interface ResolvedStart {
  provider: Provider;
  model: string;
}

/**
 * Pick a provider/model the user is actually logged into, preferring the saved
 * defaults. Mirrors the CLI's resolveActiveProvider without exporting internals.
 */
async function resolveStart(
  auth: AuthStorage,
  preferred: Provider,
  savedModel: string | undefined,
): Promise<ResolvedStart> {
  const loggedIn: Provider[] = [];
  for (const p of ALL_PROVIDERS) {
    if (await auth.hasProviderAuth(p)) loggedIn.push(p);
  }
  if (loggedIn.length === 0) {
    throw new Error('Not logged in to any provider. Run "ggcoder login" to authenticate.');
  }
  if (loggedIn.includes(preferred)) {
    const saved = savedModel ? getModel(savedModel) : undefined;
    return {
      provider: preferred,
      model: saved?.provider === preferred ? saved.id : getDefaultModel(preferred).id,
    };
  }
  const provider = loggedIn[0]!;
  return { provider, model: getDefaultModel(provider).id };
}

interface SseClient {
  id: number;
  res: http.ServerResponse;
}

async function main(): Promise<void> {
  const cwd = process.env.GG_APP_CWD ?? process.cwd();
  // Default to an ephemeral port (0) so concurrent/orphaned instances never
  // collide on a fixed port. The actual port is reported via the
  // GG_APP_LISTENING handshake and consumed by the shell.
  const port = Number(process.env.GG_APP_PORT ?? 0);
  const host = "127.0.0.1";

  const paths = await ensureAppDirs();
  // Own log file so the app sidecar never clobbers the interactive CLI's
  // ~/.gg/debug.log (initLogger truncates on each start).
  const sidecarLog = path.join(paths.agentDir, "gg-app-sidecar.log");
  initLogger(sidecarLog);

  const auth = new AuthStorage(paths.authFile);
  await auth.load();

  const saved = loadSavedSettings(paths.settingsFile);
  const preferred: Provider = saved.provider ?? "anthropic";
  const { provider, model } = await resolveStart(auth, preferred, saved.model);

  const thinkingLevel: ThinkingLevel | undefined = saved.thinkingEnabled
    ? (saved.thinkingLevel ?? getMaxThinkingLevel(model))
    : undefined;

  let abort = new AbortController();
  const session = new AgentSession({
    provider,
    model,
    cwd,
    thinkingLevel,
    signal: abort.signal,
  });
  await session.initialize();
  log("INFO", "app-sidecar", "session ready", { provider, model, cwd });

  // ── SSE fan-out ──────────────────────────────────────────
  const clients = new Set<SseClient>();
  let clientSeq = 0;

  function broadcast(type: string, data: unknown): void {
    const frame = `data: ${JSON.stringify({ type, data })}\n\n`;
    for (const c of clients) c.res.write(frame);
  }

  // Forward every relevant bus event to the webview.
  session.eventBus.on("text_delta", (d) => broadcast("text_delta", d));
  session.eventBus.on("thinking_delta", (d) => broadcast("thinking_delta", d));
  session.eventBus.on("tool_call_start", (d) => broadcast("tool_call_start", d));
  session.eventBus.on("tool_call_update", (d) => broadcast("tool_call_update", d));
  session.eventBus.on("tool_call_end", (d) => broadcast("tool_call_end", d));
  session.eventBus.on("turn_end", (d) => broadcast("turn_end", d));
  session.eventBus.on("agent_done", (d) => broadcast("agent_done", d));
  session.eventBus.on("error", (d) =>
    broadcast("error", { message: d.error instanceof Error ? d.error.message : String(d.error) }),
  );
  session.eventBus.on("model_change", (d) => broadcast("model_change", d));
  session.eventBus.on("compaction_start", (d) => broadcast("compaction_start", d));
  session.eventBus.on("compaction_end", (d) => broadcast("compaction_end", d));

  let running = false;

  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  function json(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    });
    res.end(payload);
  }

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    // CORS preflight — the webview origin differs from 127.0.0.1.
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return;
    }

    if (method === "GET" && url === "/state") {
      const st = session.getState();
      json(res, 200, { ...st, running, ready: true });
      return;
    }

    if (method === "GET" && url === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "access-control-allow-origin": "*",
      });
      res.write(`retry: 1000\n\n`);
      const client: SseClient = { id: ++clientSeq, res };
      clients.add(client);
      const st = session.getState();
      res.write(`data: ${JSON.stringify({ type: "ready", data: { ...st, running } })}\n\n`);
      const keepAlive = setInterval(() => res.write(`: ping\n\n`), 15000);
      req.on("close", () => {
        clearInterval(keepAlive);
        clients.delete(client);
      });
      return;
    }

    if (method === "POST" && url === "/prompt") {
      void readBody(req).then(async (raw) => {
        let text = "";
        try {
          text = (JSON.parse(raw) as { text?: string }).text ?? "";
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!text.trim()) {
          json(res, 400, { error: "empty prompt" });
          return;
        }
        if (running) {
          json(res, 409, { error: "agent is already running" });
          return;
        }
        json(res, 202, { accepted: true });
        running = true;
        broadcast("run_start", { text });
        try {
          await session.prompt(text);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          broadcast("error", { message });
          log("ERROR", "app-sidecar", "prompt failed", { message });
        } finally {
          running = false;
          broadcast("run_end", {});
        }
      });
      return;
    }

    if (method === "POST" && url === "/cancel") {
      abort.abort();
      abort = new AbortController();
      session.setSignal(abort.signal);
      running = false;
      broadcast("run_end", { cancelled: true });
      json(res, 200, { cancelled: true });
      return;
    }

    json(res, 404, { error: "not found" });
  });

  server.listen(port, host, () => {
    const addr = server.address() as AddressInfo;
    // The Rust shell reads this line to learn the port.
    process.stdout.write(`GG_APP_LISTENING ${addr.port}\n`);
    log("INFO", "app-sidecar", "listening", { port: String(addr.port), host });
  });

  const shutdown = async (): Promise<void> => {
    for (const c of clients) c.res.end();
    server.close();
    await session.dispose().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`GG_APP_FATAL ${message}\n`);
  process.exit(1);
});
