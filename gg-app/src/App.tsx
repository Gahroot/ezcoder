import { useState, useRef, useEffect, useCallback } from "react";
import { theme } from "./theme";
import {
  waitForReady,
  getState,
  sendPrompt,
  cancel,
  subscribe,
  type SidecarEvent,
  type AgentState,
} from "./agent";
import "./App.css";

type LineKind = "user" | "assistant" | "thinking" | "tool" | "info" | "error";

interface Line {
  id: number;
  kind: LineKind;
  text: string;
}

let idSeq = 0;
const nextId = (): number => ++idSeq;

function App(): React.ReactElement {
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [state, setState] = useState<AgentState | null>(null);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("connecting to agent\u2026");

  const readyRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The id of the assistant line currently being streamed into.
  const streamingLineRef = useRef<number | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines]);

  /** Append text to the in-flight assistant line, or open a new one. */
  // Side effects (nextId, ref mutation) happen HERE, never inside the setLines
  // updater. Updaters must be pure — React may invoke them more than once, which
  // would otherwise duplicate ids and corrupt the streaming line.
  const appendAssistant = useCallback((text: string) => {
    const current = streamingLineRef.current;
    if (current === null) {
      const newId = nextId();
      streamingLineRef.current = newId;
      setLines((prev) => [...prev, { id: newId, kind: "assistant", text }]);
    } else {
      setLines((prev) =>
        prev.map((l) => (l.id === current ? { ...l, text: l.text + text } : l)),
      );
    }
  }, []);

  const pushLine = useCallback((kind: LineKind, text: string) => {
    const id = nextId();
    setLines((prev) => [...prev, { id, kind, text }]);
  }, []);

  const handleEvent = useCallback(
    (e: SidecarEvent) => {
      const d = e.data as Record<string, unknown>;
      switch (e.type) {
        case "ready":
          setState(d as unknown as AgentState);
          setStatus("ready");
          break;
        case "run_start":
          setRunning(true);
          streamingLineRef.current = null;
          setStatus("thinking\u2026");
          break;
        case "text_delta":
          appendAssistant(String(d.text ?? ""));
          break;
        case "tool_call_start":
          streamingLineRef.current = null;
          pushLine("tool", `\u2387 ${String(d.name ?? "tool")}`);
          break;
        case "tool_call_end": {
          const isError = Boolean(d.isError);
          const ms = typeof d.durationMs === "number" ? d.durationMs : 0;
          pushLine(isError ? "error" : "info", `  ${isError ? "\u2717" : "\u2713"} done (${ms}ms)`);
          streamingLineRef.current = null;
          break;
        }
        case "compaction_start":
          pushLine("info", "compacting context\u2026");
          break;
        case "error":
          pushLine("error", `error: ${String(d.message ?? "unknown")}`);
          break;
        case "run_end":
          setRunning(false);
          streamingLineRef.current = null;
          setStatus(d.cancelled ? "cancelled" : "ready");
          break;
        case "model_change":
          setState((s) => (s ? { ...s, ...(d as Partial<AgentState>) } : s));
          break;
      }
    },
    [appendAssistant, pushLine],
  );

  useEffect(() => {
    // Synchronous subscribe/unsubscribe — guarantees exactly one live tree
    // receives events even under StrictMode/HMR double-mount.
    const unsub = subscribe(handleEvent);
    let cancelled = false;
    (async () => {
      try {
        await waitForReady();
        if (cancelled) return;
        readyRef.current = true;
        const st = await getState().catch(() => null);
        if (st) {
          setState(st);
          setStatus("ready");
        }
      } catch (err) {
        setStatus(`agent failed to start: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return () => {
      cancelled = true;
      unsub();
    };
  }, [handleEvent]);

  function submit(): void {
    const trimmed = input.trim();
    if (!trimmed || !readyRef.current || running) return;
    pushLine("user", trimmed);
    setInput("");
    streamingLineRef.current = null;
    void sendPrompt(trimmed);
  }

  function lineColor(kind: LineKind): string {
    switch (kind) {
      case "user":
        return theme.text;
      case "tool":
        return theme.toolName;
      case "thinking":
        return theme.textMuted;
      case "info":
        return theme.textDim;
      case "error":
        return theme.error;
      default:
        return theme.text;
    }
  }

  return (
    <div className="app" style={{ background: theme.background }}>
      <div className="titlebar" data-tauri-drag-region>
        <span className="title">gg-coder</span>
      </div>

      <div className="transcript" ref={scrollRef}>
        {lines.length === 0 && (
          <div className="line" style={{ color: theme.textDim }}>
            {status === "ready"
              ? "Ready. Type a message below to start coding."
              : `\u273b ${status}`}
          </div>
        )}
        {lines.map((l) => (
          <div key={l.id} className={`line ${l.kind}`} style={{ color: lineColor(l.kind) }}>
            {l.kind === "user" && <span style={{ color: theme.primary }}>{"> "}</span>}
            {l.text}
          </div>
        ))}
      </div>

      <div className="statusrow" style={{ color: theme.textDim }}>
        <span style={{ color: running ? theme.accent : theme.textDim }}>{"\u273b"}</span>{" "}
        {running ? (
          <>
            {status}{" "}
            <button
              className="cancel"
              style={{ color: theme.error }}
              onClick={() => void cancel()}
            >
              esc to cancel
            </button>
          </>
        ) : (
          status
        )}
      </div>

      <div className="inputwrap" style={{ background: theme.inputBackground }}>
        <span className="prompt" style={{ color: theme.primary }}>
          {">"}
        </span>
        <input
          className="input"
          value={input}
          placeholder="Type your message or / to run a command"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape" && running) {
              void cancel();
            }
          }}
          autoFocus
        />
      </div>

      <div className="footer" style={{ color: theme.footerText }}>
        <span className="footer-left">
          gg-coder <span style={{ color: theme.secondary }}>{"\u2387 main"}</span>
        </span>
        <span className="footer-right">
          <span style={{ color: theme.text }}>{state?.model ?? "\u2026"}</span>
          <span style={{ color: theme.textDim }}>{state?.provider ?? ""}</span>
        </span>
      </div>
    </div>
  );
}

export default App;
