import React from "react";
import { render, type Instance as InkInstance } from "ink";
import type { Message, Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { ProcessManager } from "../core/process-manager.js";
import type { MCPClientManager } from "../core/mcp/index.js";
import type { AuthStorage } from "../core/auth-storage.js";
import type { Skill } from "../core/skills.js";
import { App, type CompletedItem } from "./App.js";
import { ThemeContext, SetThemeContext, loadTheme, type ThemeName } from "./theme/theme.js";
import { detectTheme } from "./theme/detect-theme.js";
import { AnimationProvider } from "./components/AnimationContext.js";
import { TerminalSizeProvider } from "./hooks/useTerminalSize.js";
// Note: DEC 2026 synchronized output (BSU/ESU) is handled natively by Ink 6.8+
// via its built-in write-synchronized.ts module — no manual wrapping needed.

export interface RenderAppConfig {
  provider: Provider;
  model: string;
  tools: AgentTool[];
  webSearch?: boolean;
  messages: Message[];
  maxTokens: number;
  thinking?: ThinkingLevel;
  apiKey?: string;
  baseUrl?: string;
  accountId?: string;
  cwd: string;
  version: string;
  theme?: "auto" | ThemeName;
  showThinking?: boolean;
  showTokenUsage?: boolean;
  onSlashCommand?: (input: string) => Promise<string | null>;
  loggedInProviders?: Provider[];
  credentialsByProvider?: Record<
    string,
    { accessToken: string; accountId?: string; baseUrl?: string }
  >;
  initialHistory?: CompletedItem[];
  sessionsDir?: string;
  sessionPath?: string;
  processManager?: ProcessManager;
  settingsFile?: string;
  mcpManager?: MCPClientManager;
  authStorage?: AuthStorage;
  planModeRef?: { current: boolean };
  onEnterPlanRef?: { current: (reason?: string) => void };
  onExitPlanRef?: { current: (planPath: string) => Promise<string> };
  skills?: Skill[];
  initialOverlay?: "pixel";
  rebuildToolsForCwd?: (cwd: string) => AgentTool[];
}

/**
 * State that should survive a `/clear` (which unmounts and rebuilds the entire
 * Ink instance). Lives in `renderApp`'s closure so it's preserved across the
 * remount, while everything else (chat history, agent loop, plan steps, etc.)
 * gets reset along with the React tree.
 */
interface RuntimeState {
  model: string;
  provider: Provider;
  thinking?: ThinkingLevel;
}

/** Stateful theme provider — enables runtime theme switching via useSetTheme(). */
function ThemeProvider({
  initial,
  children,
}: React.PropsWithChildren<{
  initial: ThemeName;
}>) {
  const [themeName, setThemeName] = React.useState(initial);
  const theme = React.useMemo(() => loadTheme(themeName), [themeName]);
  const setTheme = React.useCallback((name: ThemeName) => setThemeName(name), []);

  return React.createElement(
    SetThemeContext.Provider,
    { value: setTheme },
    React.createElement(ThemeContext.Provider, { value: theme }, children),
  );
}

const INK_OPTIONS = {
  // Enable kitty keyboard protocol so terminals that support it can
  // distinguish Shift+Enter from Enter (needed for multiline input).
  // Terminals without support gracefully ignore this.
  kittyKeyboard: {
    mode: "enabled" as const,
    flags: ["disambiguateEscapeCodes" as const],
  },
  // Ink's built-in exitOnCtrlC checks for the raw \x03 byte, but with
  // kitty keyboard protocol Ctrl+C arrives as \x1b[99;5u so the check
  // never matches. Worse, useInput skips calling our handler when
  // exitOnCtrlC is true. Disable it so our InputArea handles Ctrl+C.
  exitOnCtrlC: false,
};

export async function renderApp(config: RenderAppConfig): Promise<void> {
  const themeSetting = config.theme ?? "auto";
  const resolvedTheme = themeSetting === "auto" ? await detectTheme() : themeSetting;

  // Clear screen + scrollback so old commands don't appear above the TUI
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");

  // Runtime state lives in this closure so /clear's unmount-and-rebuild
  // doesn't lose the user's runtime model/provider/thinking choices.
  const runtimeState: RuntimeState = {
    model: config.model,
    provider: config.provider,
    thinking: config.thinking,
  };

  const onRuntimeStateChange = (updates: Partial<RuntimeState>): void => {
    Object.assign(runtimeState, updates);
  };

  const ref: { instance: InkInstance | null } = { instance: null };

  // Build the React tree. Called once at startup AND once per /clear remount.
  // Receives `messages` so /clear can hand in a freshly built [systemPrompt]
  // while preserving the runtime model/provider/thinking choices captured in
  // the closure.
  const buildElement = (initialMessages: Message[]): React.ReactElement =>
    React.createElement(
      ThemeProvider,
      { initial: resolvedTheme },
      React.createElement(
        TerminalSizeProvider,
        null,
        React.createElement(
          AnimationProvider,
          null,
          React.createElement(App, {
            provider: runtimeState.provider,
            model: runtimeState.model,
            tools: config.tools,
            webSearch: config.webSearch,
            messages: initialMessages,
            maxTokens: config.maxTokens,
            thinking: runtimeState.thinking,
            apiKey: config.apiKey,
            baseUrl: config.baseUrl,
            accountId: config.accountId,
            cwd: config.cwd,
            version: config.version,
            showThinking: config.showThinking,
            showTokenUsage: config.showTokenUsage,
            onSlashCommand: config.onSlashCommand,
            loggedInProviders: config.loggedInProviders,
            credentialsByProvider: config.credentialsByProvider,
            initialHistory: config.initialHistory,
            sessionsDir: config.sessionsDir,
            sessionPath: config.sessionPath,
            processManager: config.processManager,
            settingsFile: config.settingsFile,
            mcpManager: config.mcpManager,
            authStorage: config.authStorage,
            planModeRef: config.planModeRef,
            onEnterPlanRef: config.onEnterPlanRef,
            onExitPlanRef: config.onExitPlanRef,
            skills: config.skills,
            initialOverlay: config.initialOverlay,
            rebuildToolsForCwd: config.rebuildToolsForCwd,
            resetUI,
            onRuntimeStateChange,
          }),
        ),
      ),
    );

  // Nuke-and-rebuild approach for /clear. Patching Ink's internal frame
  // tracking (log-update reset, lastOutput cleared, fullStaticOutput dropped)
  // looks correct for one frame but the live area drifts on subsequent
  // streaming responses — Ink's cursor math depends on terminal-state
  // assumptions that ANSI clearing breaks. The only RELIABLE reset is to
  // tear down the React tree entirely and render a fresh Ink instance.
  // gg-boss arrived at the same conclusion (see orchestrator-app.tsx).
  function resetUI(newMessages: Message[]): void {
    const old = ref.instance;
    if (!old) return;
    // Wipe the terminal first so the old instance's scrollback doesn't
    // linger above the new instance's banner.
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
    old.unmount();
    ref.instance = render(buildElement(newMessages), INK_OPTIONS);
  }

  ref.instance = render(buildElement(config.messages), INK_OPTIONS);

  // Loop: when /clear remounts, the OLD instance's waitUntilExit resolves
  // (because unmount() resolves it). We then need to wait on the NEW
  // instance. If exit was final (no replacement), ref.instance is nulled
  // by unmount and the loop ends.
  while (true) {
    const current: InkInstance | null = ref.instance;
    if (!current) return;
    await current.waitUntilExit();
    if (ref.instance === current) {
      ref.instance = null;
      return;
    }
  }
}
