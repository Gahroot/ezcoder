import { Agent, isAbortError } from "@kenkaiiii/gg-agent";
import { AuthStorage } from "@kenkaiiii/ggcoder";
import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { Worker } from "./worker.js";
import { EventQueue } from "./event-queue.js";
import { createBossTools } from "./tools.js";
import { buildBossSystemPrompt } from "./boss-system-prompt.js";
import { bossStore } from "./boss-store.js";
import type { BossEvent, ProjectSpec, WorkerTurnSummary } from "./types.js";

export interface GGBossOptions {
  bossProvider: Provider;
  bossModel: string;
  workerProvider: Provider;
  workerModel: string;
  workerThinkingLevel?: ThinkingLevel;
  projects: ProjectSpec[];
}

/**
 * The orchestrator. Owns N workers, a single shared event queue, and the boss Agent.
 * Each loop iteration: pop one event, format it as a user message, run the boss for
 * one full prompt (which may dispatch tool calls to workers), then await the next event.
 *
 * UI state is mirrored into bossStore — components subscribe via useBossState().
 */
export class GGBoss {
  private workers = new Map<string, Worker>();
  private lastSummaries = new Map<string, WorkerTurnSummary>();
  private queue = new EventQueue();
  private bossAgent!: Agent;
  private ac = new AbortController();
  /** Per-turn AbortController so ESC can cancel the current LLM call without killing workers. */
  private turnAc: AbortController | null = null;
  private running = false;
  private pendingUserMessages = 0;
  private opts: GGBossOptions;
  private authStorage = new AuthStorage();

  constructor(opts: GGBossOptions) {
    this.opts = opts;
  }

  async initialize(): Promise<void> {
    await this.authStorage.load();
    const loggedInProviders = (await this.authStorage.listProviders()) as Provider[];

    bossStore.init({
      bossProvider: this.opts.bossProvider,
      bossModel: this.opts.bossModel,
      workerProvider: this.opts.workerProvider,
      workerModel: this.opts.workerModel,
      loggedInProviders,
      workers: this.opts.projects.map((p) => ({ name: p.name, cwd: p.cwd })),
    });

    await Promise.all(
      this.opts.projects.map(async (p) => {
        const worker = new Worker({
          name: p.name,
          cwd: p.cwd,
          provider: this.opts.workerProvider,
          model: this.opts.workerModel,
          thinkingLevel: this.opts.workerThinkingLevel,
          signal: this.ac.signal,
          queue: this.queue,
        });
        await worker.initialize();
        this.workers.set(p.name, worker);
      }),
    );

    const creds = await this.authStorage.resolveCredentials(this.opts.bossProvider);
    const tools = createBossTools({
      workers: this.workers,
      lastSummaries: this.lastSummaries,
    });

    this.bossAgent = new Agent({
      provider: this.opts.bossProvider,
      model: this.opts.bossModel,
      system: buildBossSystemPrompt(this.opts.projects),
      tools,
      apiKey: creds.accessToken,
      accountId: creds.accountId,
      signal: this.ac.signal,
      cacheRetention: "short",
    });
  }

  enqueueUserMessage(text: string): void {
    this.pendingUserMessages++;
    bossStore.setPendingMessages(this.pendingUserMessages);
    this.queue.push({
      kind: "user_message",
      text,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Abort the boss's current LLM call (e.g. user pressed ESC). Workers and the
   * orchestrator's run loop keep going. The next event in the queue gets a
   * fresh AbortController.
   */
  abort(): void {
    this.turnAc?.abort();
  }

  /**
   * Swap the boss's LLM model. Preserves message history so the conversation
   * continues seamlessly under the new model.
   */
  async switchBossModel(provider: Provider, model: string): Promise<void> {
    const tools = createBossTools({
      workers: this.workers,
      lastSummaries: this.lastSummaries,
    });
    const creds = await this.authStorage.resolveCredentials(provider);
    // Capture history minus the system message — Agent re-adds system from options.
    const oldMessages = this.bossAgent.getMessages().filter((m) => m.role !== "system");

    this.opts.bossProvider = provider;
    this.opts.bossModel = model;

    this.bossAgent = new Agent({
      provider,
      model,
      system: buildBossSystemPrompt(this.opts.projects),
      tools,
      apiKey: creds.accessToken,
      accountId: creds.accountId,
      signal: this.ac.signal,
      cacheRetention: "short",
      priorMessages: oldMessages,
    });

    bossStore.setBossModel(provider, model);
  }

  /** Swap every worker's model. Workers keep their per-project sessions. */
  async switchWorkerModel(provider: Provider, model: string): Promise<void> {
    await Promise.all([...this.workers.values()].map((w) => w.switchModel(provider, model)));
    this.opts.workerProvider = provider;
    this.opts.workerModel = model;
    bossStore.setWorkerModel(provider, model);
  }

  /** Wipe boss conversation back to system prompt. Workers are unaffected. */
  async resetConversation(): Promise<void> {
    const tools = createBossTools({
      workers: this.workers,
      lastSummaries: this.lastSummaries,
    });
    const creds = await this.authStorage.resolveCredentials(this.opts.bossProvider);
    this.bossAgent = new Agent({
      provider: this.opts.bossProvider,
      model: this.opts.bossModel,
      system: buildBossSystemPrompt(this.opts.projects),
      tools,
      apiKey: creds.accessToken,
      accountId: creds.accountId,
      signal: this.ac.signal,
      cacheRetention: "short",
    });
    bossStore.setBossInputTokens(0);
  }

  async run(): Promise<void> {
    this.running = true;
    while (this.running) {
      const event = await this.queue.next();
      if (!this.running) break;

      if (event.kind === "user_message") {
        this.pendingUserMessages = Math.max(0, this.pendingUserMessages - 1);
        bossStore.setPendingMessages(this.pendingUserMessages);
      }
      if (event.kind === "worker_turn_complete") {
        this.lastSummaries.set(event.summary.project, event.summary);
      }

      const text = formatEventForBoss(event);
      bossStore.startStreaming();

      // Fresh AbortController for this turn so ESC can cancel just this call.
      this.turnAc = new AbortController();
      this.bossAgent.setSignal(this.turnAc.signal);

      try {
        const stream = this.bossAgent.prompt(text);
        for await (const e of stream) {
          switch (e.type) {
            case "text_delta":
              bossStore.appendStreamText(e.text);
              break;
            case "thinking_delta":
              bossStore.appendStreamThinking(e.text);
              break;
            case "tool_call_start":
              // Flush any preceding text so chronological order is preserved
              // in scrollback (text → tool → text → tool, not text-block then tool-block).
              bossStore.flushPendingText();
              bossStore.startTool(e.toolCallId, e.name, e.args);
              bossStore.setActivityPhase("tools");
              break;
            case "tool_call_end":
              bossStore.endTool(e.toolCallId, e.isError, e.durationMs, e.result, e.details);
              break;
            case "turn_end":
              // Latest turn's input tokens IS the current context size (each turn
              // re-sends the whole conversation), so just track the most recent.
              if (e.usage?.inputTokens != null) {
                bossStore.setBossInputTokens(e.usage.inputTokens);
              }
              // Flush trailing text from this turn. Subsequent turns may add more.
              bossStore.flushPendingText();
              break;
            case "retry":
              if (!e.silent) {
                bossStore.setRetryInfo({
                  reason: e.reason,
                  attempt: e.attempt,
                  maxAttempts: e.maxAttempts,
                  delayMs: e.delayMs,
                });
              }
              break;
            case "error":
              bossStore.appendInfo(formatProviderError(e.error.message), "error");
              break;
            default:
              break;
          }
        }
      } catch (err) {
        if (isAbortError(err)) {
          // Mirror ggcoder's onAborted: convert any in-flight tools to
          // "Stopped." entries so the user sees the same visual feedback.
          bossStore.interruptStreaming();
          if (!this.running) {
            bossStore.finishStreaming();
            return;
          }
          bossStore.appendInfo("Interrupted by user.", "warning");
          bossStore.finishStreaming();
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        bossStore.appendInfo(formatProviderError(message), "error");
      }
      bossStore.finishStreaming();
    }
  }

  async dispose(): Promise<void> {
    this.running = false;
    this.ac.abort();
    // Wake the queue if it's blocked on next() so the run loop can exit.
    this.queue.push({
      kind: "user_message",
      text: "[shutdown]",
      timestamp: new Date().toISOString(),
    });
    await Promise.all([...this.workers.values()].map((w) => w.dispose()));
  }
}

function formatEventForBoss(event: BossEvent): string {
  if (event.kind === "user_message") {
    return event.text;
  }
  if (event.kind === "worker_turn_complete") {
    const s = event.summary;
    const tools =
      s.toolsUsed.length > 0
        ? s.toolsUsed.map((t) => `${t.ok ? "✓" : "✗"}${t.name}`).join(", ")
        : "(none)";
    return `[event:worker_turn_complete] project="${s.project}" turn=${s.turnIndex} timestamp=${s.timestamp}
tools_used: ${tools}
final_text:
${s.finalText || "(empty)"}`;
  }
  return `[event:worker_error] project="${event.project}" timestamp=${event.timestamp}
${event.message}`;
}

/**
 * Map raw provider error text to a human-friendly hint. Mirrors ggcoder's
 * pattern in App.tsx so users see the same diagnostic phrasing.
 */
function formatProviderError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("overloaded") || lower.includes("engine_overloaded")) {
    return `${message}\nHint: provider is under heavy load — try again in a moment.`;
  }
  if (
    lower.includes("insufficient balance") ||
    lower.includes("quota exceeded") ||
    lower.includes("recharge")
  ) {
    return `${message}\nHint: billing or quota issue — check your account balance.`;
  }
  if (
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("429")
  ) {
    return `${message}\nHint: provider rate limit — wait a moment before retrying.`;
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return `${message}\nHint: provider timed out — their servers may be slow.`;
  }
  if (
    lower.includes("does not recognize the requested model") ||
    (lower.includes("model") && (lower.includes("not exist") || lower.includes("not found")))
  ) {
    return `${message}\nHint: use /model to switch, or check that your account has access.`;
  }
  return message;
}
