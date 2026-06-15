// Screenshot showcase entry — a separate Vite entry (see vite.showcase.config.ts)
// that renders each real app screen with the canned Tauri mock, so the
// landing-page captures use the genuine components, not re-implementations.
//
// Drive it by URL: /showcase.html?screen=home (see SCREENS below). It never
// ships — the packaged app builds from index.html / src/main.tsx only.

import { useEffect } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";

import App from "../src/App";
import { HomeScreen } from "../src/HomeScreen";
import { LoginScreen } from "../src/LoginScreen";
import { ProjectPicker } from "../src/ProjectPicker";
import { ProviderLoginModal } from "../src/ProviderLoginModal";
import { NewProjectModal } from "../src/NewProjectModal";
import { SettingsModal } from "../src/SettingsModal";
import { TasksModal } from "../src/TasksModal";
import { PlanReviewModal } from "../src/PlanReviewModal";
import "../src/App.css";

import { emitAgentEvent } from "./tauri-mock";
import { PLAN_MARKDOWN, PROJECTS, PROJECTS_ROOT, PROVIDERS, TASKS } from "./data";

const noop = (): void => {};
const params = new URLSearchParams(location.search);
const screen = params.get("screen") ?? "home";

/** Full-window screens render their own `.home`/`.picker` container; wrap them
 *  in `.app` so the 100vh layout + background match the real window. */
function Stage({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="app">{children}</div>;
}

/** A scripted "agent is working" run, fired once the chat is live, for the
 *  dynamic capture (live tool panel + activity bar). */
function useScriptedRun(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let fired = false;
    const tick = setInterval(() => {
      // Wait until App has navigated into the chat (the live region exists).
      if (fired || !document.querySelector(".liveregion")) return;
      fired = true;
      clearInterval(tick);
      emitAgentEvent("run_start", {});
      emitAgentEvent("thinking_delta", {});
      window.setTimeout(() => {
        emitAgentEvent("tool_call_start", {
          toolCallId: "a",
          name: "read",
          args: { file_path: "ezcoder-app/src/ActivityBar.tsx" },
        });
        emitAgentEvent("tool_call_end", { toolCallId: "a", result: "138 lines" });
        emitAgentEvent("tool_call_start", {
          toolCallId: "b",
          name: "grep",
          args: { pattern: "contextTokens", include: "*.tsx" },
        });
        emitAgentEvent("tool_call_end", { toolCallId: "b", result: "7 matches" });
        emitAgentEvent("tool_call_start", {
          toolCallId: "c",
          name: "edit",
          args: { file_path: "ezcoder-app/src/ContextMeter.tsx" },
        });
        emitAgentEvent("text_delta", {
          text: "Wiring the meter into the footer-right group now — ",
        });
        emitAgentEvent("text_delta", { text: "amber past 70%, red past 90%." });
      }, 250);
    }, 120);
    return () => clearInterval(tick);
  }, [enabled]);
}

function Showcase(): React.ReactElement {
  useScriptedRun(screen === "chat-live");

  switch (screen) {
    case "home":
      return (
        <Stage>
          <HomeScreen onProjects={noop} onLogin={noop} />
        </Stage>
      );

    case "login":
      return (
        <Stage>
          <LoginScreen onClose={noop} />
        </Stage>
      );

    case "provider":
      return (
        <Stage>
          <LoginScreen onClose={noop} />
          <ProviderLoginModal provider={PROVIDERS[0]!} onClose={noop} onChanged={noop} />
        </Stage>
      );

    case "projects":
      return (
        <Stage>
          <ProjectPicker onChosen={noop} />
        </Stage>
      );

    case "sessions":
      return (
        <Stage>
          <ProjectPicker onChosen={noop} initialProjectPath={PROJECTS[0]!.path} />
        </Stage>
      );

    case "new-project":
      return (
        <Stage>
          <ProjectPicker onChosen={noop} />
          <NewProjectModal projectsRoot={PROJECTS_ROOT} onClose={noop} onCreated={noop} />
        </Stage>
      );

    case "settings":
      return (
        <Stage>
          <HomeScreen onProjects={noop} onLogin={noop} />
          <SettingsModal onClose={noop} onSaved={noop} />
        </Stage>
      );

    case "tasks":
      return (
        <Stage>
          <ProjectPicker onChosen={noop} />
          <TasksModal
            tasks={TASKS}
            running={false}
            onRun={noop}
            onRunAll={noop}
            onDelete={noop}
            onClose={noop}
          />
        </Stage>
      );

    case "plan":
      return (
        <Stage>
          <PlanReviewModal
            content={PLAN_MARKDOWN}
            onAccept={noop}
            onFeedback={noop}
            onReject={noop}
          />
        </Stage>
      );

    case "chat":
    case "chat-live":
      // The real App, driven into a project by screenshot click actions.
      return <App />;

    default:
      return (
        <Stage>
          <HomeScreen onProjects={noop} onLogin={noop} />
        </Stage>
      );
  }
}

// Showcase-only cosmetics: hide the decorative meme cards (external GIFs) so the
// home capture is clean and brand-focused, and never show a scrollbar.
const style = document.createElement("style");
style.textContent = `
  .meme-layer { display: none !important; }
  html, body { overflow: hidden !important; }
`;
document.head.appendChild(style);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<Showcase />);
