// Drop-in replacement for the `@tauri-apps/*` modules, used ONLY by the
// screenshot showcase (wired up via `resolve.alias` in vite.showcase.config.ts).
// It answers every `invoke(...)` the webview makes with canned data from
// `data.ts`, so the real screen components render with believable content in a
// plain browser — no Rust shell, no Node sidecar, no auth.
//
// This file never ships in the packaged app: the showcase is a separate Vite
// entry/config and lives outside `src/`, which is the only thing tsconfig and
// the app build include.

import * as data from "./data";

type Json = Record<string, unknown>;
type EventCb = (event: { payload: unknown }) => void;

// agent-event listeners, so the showcase can push a scripted run for the
// "agent working" capture.
const agentEventListeners = new Set<EventCb>();

/** Emit a forwarded sidecar event to every live listener. */
export function emitAgentEvent(type: string, payload: unknown): void {
  for (const cb of agentEventListeners) cb({ payload: { type, data: payload } });
}

const RESULTS: Record<string, (args: Json) => unknown> = {
  // Readiness — a number means "sidecar is up", which resolves waitForReady().
  sidecar_port: () => 41700,

  // State + catalogs.
  agent_state: () => data.STATE,
  agent_auth_status: () => ({ providers: data.PROVIDERS }),
  agent_models: () => ({ models: data.MODELS }),
  agent_commands: () => ({ commands: data.COMMANDS }),
  agent_tasks: () => ({ tasks: data.TASKS }),
  agent_history: () => ({ history: data.HISTORY }),
  agent_projects: () => ({ projects: data.PROJECTS }),
  agent_sessions: () => ({ sessions: data.SESSIONS }),
  agent_radio_state: () => ({ stations: data.RADIO_STATIONS, current: null }),

  // App settings (read natively in Rust in the real app).
  app_settings_get: () => ({ projectsRoot: data.PROJECTS_ROOT, configured: true }),
  app_create_project: (args) => ({ path: `${data.PROJECTS_ROOT}/${String(args.name ?? "new")}` }),

  // Serve / Telegram — present but idle so the home screen reads cleanly.
  agent_serve_status: () => ({ running: false, configured: false }),
  agent_telegram_get: () => ({ configured: false }),

  // Mutations — accepted, no-op.
  app_settings_save: () => null,
  select_project: () => null,
  agent_prompt: () => null,
  agent_cancel: () => null,
  agent_new_session: () => null,
  agent_switch_model: (args) => ({
    provider: data.STATE.provider,
    model: String(args.model ?? data.STATE.model),
    thinkingLevel: data.STATE.thinkingLevel ?? null,
    supportedThinkingLevels: data.STATE.supportedThinkingLevels ?? [],
  }),
  agent_cycle_thinking: () => ({
    thinkingLevel: "high",
    supportedThinkingLevels: data.STATE.supportedThinkingLevels ?? [],
  }),
  agent_delete_task: () => ({ tasks: data.TASKS }),
  agent_run_tasks: () => null,
  agent_kill_task: () => ({ message: null }),
  agent_radio_set: () => ({ current: null }),
  agent_auth_apikey: () => null,
  agent_auth_oauth_start: () => null,
  agent_auth_oauth_code: () => null,
  agent_auth_logout: () => null,
  agent_telegram_save: () => null,
  agent_serve_start: () => null,
  agent_serve_stop: () => null,
  setup_windows: () => null,
  new_window: () => null,
};

/** Mock of `@tauri-apps/api/core`'s invoke. */
export async function invoke<T = unknown>(cmd: string, args: Json = {}): Promise<T> {
  const handler = RESULTS[cmd];
  if (!handler) {
    // Unknown command — resolve to null so nothing throws during a capture.
    return null as T;
  }
  return handler(args) as T;
}

// ── @tauri-apps/api/webviewWindow ──────────────────────────
const LABEL = new URLSearchParams(location.search).get("label") || "main";

const webviewWindow = {
  label: LABEL,
  async listen(event: string, cb: EventCb): Promise<() => void> {
    if (event === "agent-event") {
      agentEventListeners.add(cb);
      return () => agentEventListeners.delete(cb);
    }
    // sidecar-ready etc. — never fired (sidecar_port already resolves ready).
    return () => {};
  },
  async setTitle(): Promise<void> {},
  async setSize(): Promise<void> {},
};

export function getCurrentWebviewWindow(): typeof webviewWindow {
  return webviewWindow;
}

// ── @tauri-apps/api/app ────────────────────────────────────
export async function getVersion(): Promise<string> {
  return "0.1.10";
}

// ── @tauri-apps/plugin-log ─────────────────────────────────
export async function info(): Promise<void> {}
export async function error(): Promise<void> {}
export async function warn(): Promise<void> {}
export async function debug(): Promise<void> {}
export async function trace(): Promise<void> {}
export async function attachConsole(): Promise<() => void> {
  return () => {};
}

// ── @tauri-apps/plugin-opener ──────────────────────────────
export async function openUrl(): Promise<void> {}

// ── @tauri-apps/plugin-dialog ──────────────────────────────
export async function open(): Promise<string | null> {
  return `${data.PROJECTS_ROOT}`;
}

// ── @tauri-apps/plugin-process ─────────────────────────────
export async function relaunch(): Promise<void> {}

// ── @tauri-apps/plugin-updater ─────────────────────────────
export interface Update {
  available: boolean;
  version: string;
  downloadAndInstall(): Promise<void>;
}
export async function check(): Promise<Update | null> {
  // No pending update — keeps the captures free of the update banner.
  return null;
}
