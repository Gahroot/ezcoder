// Client bridge to the Node agent sidecar — routed entirely through Rust IPC.
// The webview is served from a secure `tauri://` origin, so it cannot fetch the
// sidecar's plain-HTTP endpoints directly (mixed-content). Rust proxies for us:
//   - invoke("agent_state" | "agent_prompt" | "agent_cancel")
//   - listen("agent-event")  ← forwarded SSE frames
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { error as logError, info as logInfo } from "@tauri-apps/plugin-log";

export interface SidecarEvent {
  type: string;
  data: unknown;
}

export interface AgentState {
  provider: string;
  model: string;
  cwd: string;
  running: boolean;
}

export async function getState(): Promise<AgentState> {
  return invoke<AgentState>("agent_state");
}

export async function sendPrompt(text: string): Promise<void> {
  await logInfo(`prompt: ${text.slice(0, 80)}`);
  try {
    await invoke("agent_prompt", { text });
  } catch (e) {
    await logError(`agent_prompt failed: ${String(e)}`);
    throw e;
  }
}

export async function cancel(): Promise<void> {
  try {
    await invoke("agent_cancel");
  } catch (e) {
    await logError(`agent_cancel failed: ${String(e)}`);
  }
}

// Single Tauri listener for the whole app, fanned out to local subscribers.
// Registering the OS-level listener once at module scope (not per React mount)
// eliminates the StrictMode/HMR double-mount race where two async `listen()`
// calls leave two live listeners updating two independent state trees.
const localSubscribers = new Set<(e: SidecarEvent) => void>();
let tauriListenerStarted = false;

function ensureTauriListener(): void {
  if (tauriListenerStarted) return;
  tauriListenerStarted = true;
  void listen<SidecarEvent>("agent-event", (e) => {
    for (const fn of localSubscribers) fn(e.payload);
  });
}

/**
 * Subscribe to forwarded agent events. Synchronous add/remove against the local
 * fan-out — no async cleanup window, so exactly one render tree sees events.
 */
export function subscribe(onEvent: (e: SidecarEvent) => void): () => void {
  ensureTauriListener();
  localSubscribers.add(onEvent);
  return () => localSubscribers.delete(onEvent);
}

/** Wait until the sidecar reports a port (proves the agent is up). */
export async function waitForReady(): Promise<void> {
  const immediate = await invoke<number | null>("sidecar_port").catch(() => null);
  if (typeof immediate === "number") return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        clearInterval(poll);
        reject(new Error("sidecar did not start in time"));
      }
    }, 30000);
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(poll);
      resolve();
    };
    listen<number>("sidecar-ready", finish).catch(() => {});
    const poll = setInterval(() => {
      void invoke<number | null>("sidecar_port").then((p) => {
        if (typeof p === "number") finish();
      });
    }, 500);
  });
}
