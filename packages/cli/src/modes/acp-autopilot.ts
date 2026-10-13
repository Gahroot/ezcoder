/**
 * Autopilot Nolan for `ezcoder acp`: the reviewer session the autopilot cycle
 * prompts. Built like the desktop's `ensureNolanAutoSession` (app-sidecar.ts):
 * Nolan's autopilot system prompt, Nolan's read-only tool set, a transient
 * session, long cache retention, and the project's Nolan model pin when one is
 * valid (otherwise Nolan follows EZ Coder's model, as on the desktop).
 */
import type { Provider } from "@prestyj/ai";
import { getModel } from "@prestyj/core";
import { AgentSession } from "../core/agent-session.js";
import { buildNolanAutopilotSystemPrompt } from "../core/nolan-prompt.js";
import { validateNolanModelPref } from "../core/nolan-model.js";
import { NOLAN_ALLOWED_TOOLS, lastAssistantText } from "../app-sidecar/nolan-context.js";
import { loadNolanModelPref } from "../app-sidecar/app-settings.js";

/** The reviewer the ACP autopilot cycle talks to. A seam so tests can script Nolan. */
export interface AcpNolanReviewer {
  /** Wipe review history (start of each cycle). */
  reset(): Promise<void>;
  /** Prompt Nolan with a digest; resolves to his final reply text. */
  review(digest: string): Promise<string>;
  /** Stop an in-flight review (session/cancel, queued message). */
  abort(): void;
  dispose(): Promise<void>;
}

export interface AcpNolanReviewerOptions {
  cwd: string;
  /** EZ Coder's current model; Nolan follows it unless the project pins his own. */
  buildModel: () => { provider: Provider; model: string };
}

export function createAcpNolanReviewer(options: AcpNolanReviewerOptions): AcpNolanReviewer {
  let abort = new AbortController();
  let nolan: AgentSession | null = null;

  async function ensure(): Promise<AgentSession> {
    if (nolan) return nolan;
    const pinned = validateNolanModelPref(await loadNolanModelPref(options.cwd), {
      modelExists: (id) => getModel(id) !== undefined,
      providerConnected: () => true,
    });
    const target = pinned ?? options.buildModel();
    const created = new AgentSession({
      provider: target.provider,
      model: target.model,
      cwd: options.cwd,
      systemPrompt: await buildNolanAutopilotSystemPrompt(options.cwd),
      allowedTools: NOLAN_ALLOWED_TOOLS,
      transient: true,
      signal: abort.signal,
      forceLongCacheRetention: true,
    });
    await created.initialize();
    nolan = created;
    return created;
  }

  return {
    async reset() {
      await nolan?.newSession().catch(() => undefined);
    },
    async review(digest) {
      const session = await ensure();
      await session.prompt(digest);
      return lastAssistantText(session.getMessages());
    },
    abort() {
      abort.abort();
      abort = new AbortController();
      nolan?.setSignal(abort.signal);
    },
    async dispose() {
      abort.abort();
      const current = nolan;
      nolan = null;
      await current?.dispose();
    },
  };
}
