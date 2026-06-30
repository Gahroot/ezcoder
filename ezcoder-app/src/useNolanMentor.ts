import { useCallback, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { SidecarEvent } from "./agent";
import type { Item } from "./App";

/**
 * Nolan Grout (mentor agent) client state + event handling, extracted from App.tsx.
 *
 * Nolan runs as a second, read-only agent alongside the EZ Coder build session, so
 * his activity is fully independent: his own running flag, token count, and
 * thinking timer (mirroring the build session's so his activity bar reads the
 * same), plus his own streaming bubble in the shared transcript. All of it is
 * driven by the `ken_*` family of SSE events, which `handleNolanEvent` consumes.
 *
 * The hook owns no transcript array of its own — it appends/updates Nolan bubbles
 * through the App's `setItems` (so Nolan's messages interleave with the build
 * transcript) and mints ids with the App's shared `nextId` (so ids stay globally
 * unique). Only the `Item` type is imported, type-only, so there's no runtime
 * import cycle with App.
 */
export interface NolanMentor {
  /** True while Nolan is mid-run (drives his activity bar's visibility). */
  nolanRunning: boolean;
  /** Accumulated output tokens for Nolan's current run. */
  nolanTokens: number;
  /** Timestamp (ms) Nolan's run began, or null when idle. */
  nolanRunStartTs: number | null;
  /** True while Nolan is actively emitting reasoning/thinking. */
  nolanIsThinking: boolean;
  /** Timestamp (ms) Nolan's current thinking span began, or null. */
  nolanThinkingStartTs: number | null;
  /** Completed thinking time (ms) from earlier spans in this run. */
  nolanThinkingAccumMs: number;
  /**
   * Handle one `ken_*` SSE event. Returns true when the event belonged to Nolan
   * and was consumed, so the caller can early-return; false for anything else.
   */
  handleNolanEvent: (e: SidecarEvent) => boolean;
}

export function useNolanMentor(opts: {
  setItems: Dispatch<SetStateAction<Item[]>>;
  nextId: () => number;
}): NolanMentor {
  const { setItems, nextId } = opts;

  const [nolanRunning, setNolanRunning] = useState(false);
  // Nolan's own activity metrics, mirroring the build session's so Nolan's activity
  // bar shows the SAME elapsed/tokens/thinking readout (just tinted to Nolan).
  const [nolanTokens, setNolanTokens] = useState(0);
  const [nolanRunStartTs, setNolanRunStartTs] = useState<number | null>(null);
  const [nolanIsThinking, setNolanIsThinking] = useState(false);
  const [nolanThinkingStartTs, setNolanThinkingStartTs] = useState<number | null>(null);
  const [nolanThinkingAccumMs, setNolanThinkingAccumMs] = useState(0);
  const nolanTokensRef = useRef(0);
  const nolanThinkingStartRef = useRef<number | null>(null);
  const nolanThinkingAccumRef = useRef(0);
  // Id of the active Nolan streaming bubble (null when Nolan isn't streaming).
  const nolanStreamingIdRef = useRef<number | null>(null);

  // Nolan's streaming bubble. Nolan's replies are short, so a direct setItems per
  // delta (no rAF buffering) is fine and keeps his path independent of GG
  // Coder's. First delta creates the magenta bubble; later deltas append to it.
  const appendNolan = useCallback(
    (text: string) => {
      const current = nolanStreamingIdRef.current;
      if (current === null) {
        const id = nextId();
        nolanStreamingIdRef.current = id;
        setItems((prev) => [...prev, { kind: "ken", id, text }]);
      } else {
        setItems((prev) =>
          prev.map((it) =>
            it.kind === "ken" && it.id === current ? { ...it, text: it.text + text } : it,
          ),
        );
      }
    },
    [setItems, nextId],
  );

  // Ends the CURRENT Nolan streaming bubble (also called mid-turn on tool calls to
  // break the bubble so post-tool text starts a fresh paragraph).
  const endNolanStreaming = useCallback(() => {
    nolanStreamingIdRef.current = null;
  }, []);

  // Close Nolan's open thinking span (if any), folding its duration into the
  // accumulator. Mirrors the build's finalizeThinking. Called when text or a
  // tool begins, or the run ends, so the thinking timer doesn't over-count.
  const finalizeNolanThinking = useCallback(() => {
    if (nolanThinkingStartRef.current !== null) {
      nolanThinkingAccumRef.current += Date.now() - nolanThinkingStartRef.current;
      nolanThinkingStartRef.current = null;
      setNolanThinkingAccumMs(nolanThinkingAccumRef.current);
      setNolanThinkingStartTs(null);
    }
    setNolanIsThinking(false);
  }, []);

  const handleNolanEvent = useCallback(
    (e: SidecarEvent): boolean => {
      const d = e.data as Record<string, unknown>;
      switch (e.type) {
        // ── Nolan Grout (mentor agent) ──────────────────────────────
        // Separate event family so Nolan's reply renders in its own magenta
        // bubble and never touches EZ Coder's streaming bubble / tool feed.
        case "nolan_run_start":
          setNolanRunning(true);
          endNolanStreaming();
          // Reset Nolan's activity metrics for this run (mirrors the build run_start).
          nolanTokensRef.current = 0;
          nolanThinkingStartRef.current = null;
          nolanThinkingAccumRef.current = 0;
          setNolanTokens(0);
          setNolanRunStartTs(Date.now());
          setNolanIsThinking(false);
          setNolanThinkingStartTs(null);
          setNolanThinkingAccumMs(0);
          return true;
        case "nolan_text_delta":
          // First visible output ends any thinking span (mirrors finalizeThinking).
          finalizeNolanThinking();
          appendNolan(String(d.text ?? ""));
          return true;
        case "nolan_thinking_delta":
          if (nolanThinkingStartRef.current === null) {
            const now = Date.now();
            nolanThinkingStartRef.current = now;
            setNolanThinkingStartTs(now);
            setNolanIsThinking(true);
          }
          return true;
        // A tool runs mid-turn: end Nolan's current bubble so text streamed AFTER
        // the tool starts a fresh paragraph instead of gluing onto the pre-tool
        // text ("...work.Local tools..."). Mirrors the build session's
        // tool_call_start / server_tool_call handling. Covers both client tools
        // (read/grep/kencode-search) and Anthropic's native server web_search.
        case "nolan_tool_call_start":
        case "nolan_server_tool_call":
          // Close any open thinking span (mirrors the build's finalizeThinking on
          // tool_call_start) so the timer doesn't keep counting while a tool runs.
          finalizeNolanThinking();
          endNolanStreaming();
          return true;
        case "nolan_turn_end": {
          const usage = d.usage as { outputTokens?: number } | undefined;
          if (usage && typeof usage.outputTokens === "number") {
            nolanTokensRef.current += usage.outputTokens;
            setNolanTokens(nolanTokensRef.current);
          }
          return true;
        }
        case "nolan_run_end":
          setNolanRunning(false);
          endNolanStreaming();
          // Close any open thinking span so the final readout is accurate.
          finalizeNolanThinking();
          setNolanRunStartTs(null);
          return true;
        case "nolan_error":
          setNolanRunning(false);
          endNolanStreaming();
          setNolanIsThinking(false);
          setNolanRunStartTs(null);
          setItems((prev) => [
            ...prev,
            { kind: "error", id: nextId(), text: `Nolan: ${String(d.message ?? "unknown")}` },
          ]);
          return true;
        // nolan_tool_call_update / nolan_tool_call_end carry Nolan's read-only tool
        // activity; the activity bar (nolanRunning) is the indicator, so they need
        // no transcript row. (nolan_tool_call_start IS handled above to break the
        // streaming bubble around mid-turn tool calls.) Consume them so the
        // caller doesn't fall through to the build-event switch.
        case "nolan_tool_call_update":
        case "nolan_tool_call_end":
          return true;
        default:
          return false;
      }
    },
    [appendNolan, endNolanStreaming, finalizeNolanThinking, setItems, nextId],
  );

  return {
    nolanRunning,
    nolanTokens,
    nolanRunStartTs,
    nolanIsThinking,
    nolanThinkingStartTs,
    nolanThinkingAccumMs,
    handleNolanEvent,
  };
}
