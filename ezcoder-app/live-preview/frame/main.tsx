// The live preview chat: ezcoder-app's real Deck, ActivityBar, Composer and
// transcript rows, in a cross-origin iframe on the previewed page. It talks to
// the preview's own session through the frame server (shims/invoke.ts), and to
// the page only through the postMessage protocol (../protocol.ts).
import "../../src/App.css";
import "./live.css";
import {
  StrictMode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { ChatCircleDotsIcon, CursorClickIcon, MinusIcon } from "@phosphor-icons/react";
import { ActivityBar } from "../../src/ActivityBar";
import { Composer } from "../../src/Composer";
import { LiveToolPanel, type LiveToolEntry } from "../../src/LiveToolPanel";
import { PromptSendProvider } from "../../src/Markdown";
import { TranscriptRow } from "../../src/TranscriptRow";
import type { Item } from "../../src/transcript-item";
import { useAgentEvents } from "../../src/useAgentEvents";
import { createLiveTextStore, LiveTextContext } from "../../src/live-text";
import { createEntranceLifetime } from "../../src/transcript-motion";
import { INITIAL_ACTIVITY, reduceTaskActivity, type TaskActivity } from "../../src/task-activity";
import { usePromptEnhance } from "../../src/usePromptEnhance";
import {
  cancel,
  getState,
  sendPrompt,
  type AgentState,
  type ModelOption,
  type SidecarEvent,
} from "../../src/agent";
import type { PendingAttachment } from "../../src/attachments";
import type { PromptSegment } from "../../src/agent";
import { chipName, toDevUrl, type PickedElement } from "../protocol";
import { createParentBridge } from "./bridge";
import { streamEvents } from "./events";
import { LIVE_HEADER } from "./shims/invoke";

interface FrameConfig {
  devUrl: string;
  proxyOrigins: string[];
}

const bridge = createParentBridge();
const UI_KEY = "ez-live-ui";
const NOTE_KEY = "ez-live-port-note";
const DRAFT_KEY = "ez-live-draft";

const readJson = <T,>(storage: Storage, key: string, fallback: T): T => {
  try {
    return (JSON.parse(storage.getItem(key) || "null") as T | null) ?? fallback;
  } catch {
    return fallback;
  }
};

function LiveApp() {
  // ── Session state, as ezcoder-app's App keeps it ──
  const [config, setConfig] = useState<FrameConfig | null>(null);
  const [state, setState] = useState<AgentState | null>(null);
  const [, setModels] = useState<ModelOption[]>([]);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [tokens, setTokens] = useState(0);
  const [doneStatus, setDoneStatus] = useState<string | null>(null);
  const [isThinking, setIsThinking] = useState(false);
  const [thinkingStartTs, setThinkingStartTs] = useState<number | null>(null);
  const [thinkingAccumMs, setThinkingAccumMs] = useState(0);
  const [liveToolFeed, setLiveToolFeed] = useState<LiveToolEntry[]>([]);
  const [, setContextTokens] = useState(0);
  const [activity, setActivity] = useState<TaskActivity>(INITIAL_ACTIVITY);
  const [toolsHidden, setToolsHidden] = useState(false);
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);

  const refreshState = useCallback(() => {
    getState()
      .then(setState)
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshState();
  }, [refreshState]);

  // ── Session events through ezcoder-app's own useAgentEvents ──
  const [items, setItems] = useState<Item[]>([]);
  const idRef = useRef(0);
  const nextId = useCallback(() => ++idRef.current, []);
  const [liveText] = useState(createLiveTextStore);
  const noopSet = useCallback(() => {}, []) as never;
  const refs = {
    planDoneRef: useRef(new Set<number>()),
    planTotalRef: useRef(0),
    planReviewPathRef: useRef<string | null>(null),
    pendingPlanTotalRef: useRef<number | null>(null),
    stickToBottomRef: useRef(true),
  };
  const { handleEvent } = useAgentEvents({
    setItems,
    nextId,
    liveText,
    stateRef,
    handleNolanEvent: () => false,
    handleAutopilotEvent: () => false,
    handleActivityEvent: (e) => setActivity((a) => reduceTaskActivity(a, e, Date.now())),
    setState,
    setRunning,
    setLiveToolFeed,
    setTokens,
    setContextTokens,
    setDoneStatus,
    setIsThinking,
    setThinkingStartTs,
    setThinkingAccumMs,
    setModels,
    setTasks: noopSet,
    setProjectTasks: noopSet,
    setStatus: noopSet,
    setPlanTotal: noopSet,
    setPlanDone: noopSet,
    setPlanReview: noopSet,
    setQueuedCount: noopSet,
    setQueuedMessages: noopSet,
    setAttachments: noopSet,
    setCommands: noopSet,
    ...refs,
    onRunEnd: () => {
      setCancelling(false);
      refreshState();
    },
  });
  // A message sent mid-run waits in the queue; its bubble says so until the agent takes it.
  const awaitingDrain = useRef(false);
  const markQueued = (queued: boolean) =>
    setItems((prev) => {
      let i = prev.length - 1;
      while (i >= 0 && prev[i].kind !== "user") i--;
      return i < 0 ? prev : prev.map((it, j) => (j === i ? ({ ...it, queued } as Item) : it));
    });
  const onEvent = useRef<(e: SidecarEvent) => void>(() => {});
  useLayoutEffect(() => {
    onEvent.current = (e) => {
      const d = (e.data ?? {}) as Record<string, unknown>;
      handleEvent(e);
      if (e.type === "live_preview_prompt" && d.queued === true) {
        awaitingDrain.current = true;
        markQueued(true);
      } else if (e.type === "run_start") {
        setRunStartedAt(Date.now());
        if (awaitingDrain.current) {
          awaitingDrain.current = false;
          markQueued(false);
        }
      } else if (e.type === "queued" && d.count === 0 && awaitingDrain.current) {
        awaitingDrain.current = false;
        markQueued(false);
      }
    };
  });
  useEffect(
    () =>
      streamEvents(
        (e) => onEvent.current(e),
        // Every connection replays the session from the start: rebuild, don't append.
        () => {
          setItems([]);
          awaitingDrain.current = false;
        },
      ),
    [],
  );

  // ── Open/minimised, remembered across page loads ──
  const [open, setOpen] = useState<boolean>(
    () => readJson(sessionStorage, UI_KEY, { open: true }).open,
  );

  // ── The page: its address, viewport and picked element ──
  const [pageUrl, setPageUrl] = useState("");
  const [picked, setPicked] = useState<PickedElement | null>(null);
  const [pickMissing, setPickMissing] = useState(false);
  const [picking, setPicking] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const focusInput = () =>
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  useEffect(() => {
    const off = bridge.onMessage((msg) => {
      switch (msg.type) {
        case "ez-live:hello":
        case "ez-live:viewport": {
          const root = document.documentElement.style;
          root.setProperty("--host-vw", `${msg.viewport.width}px`);
          root.setProperty("--host-vh", `${msg.viewport.height}px`);
          if (msg.type === "ez-live:hello") setPageUrl(msg.url);
          break;
        }
        case "ez-live:url":
          setPageUrl(msg.url);
          break;
        case "ez-live:picked":
          setPicked(msg.element);
          setPickMissing(msg.missing);
          break;
        case "ez-live:picking":
          setPicking(msg.on);
          break;
        case "ez-live:focus":
          // Sent after a new pick: bring the chat up to ask about it.
          setOpen(true);
          focusInput();
          break;
      }
    });
    fetch("/api/config", { headers: { [LIVE_HEADER]: "1" }, credentials: "omit" })
      .then((r) => (r.ok ? (r.json() as Promise<FrameConfig>) : Promise.reject(r.status)))
      .then((c) => {
        setConfig(c);
        bridge.setOrigins(c.proxyOrigins);
        bridge.post({ type: "ez-live:ready" });
      })
      .catch(() => {});
    return off;
  }, []);

  useEffect(() => {
    sessionStorage.setItem(UI_KEY, JSON.stringify({ open }));
    bridge.post({ type: "ez-live:open", open });
  }, [open, config]);

  // Mirror our size onto the iframe's clip, so it shows (and takes clicks on) the chat only.
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    let last = "";
    const report = () => {
      const width = Math.ceil(el.offsetWidth);
      const height = Math.ceil(el.offsetHeight);
      const key = `${width}x${height}`;
      if (key === last) return;
      last = key;
      bridge.post({ type: "ez-live:size", width, height });
    };
    const ro = new ResizeObserver(report);
    ro.observe(el);
    report();
    return () => {
      ro.disconnect();
    };
  }, [config]);

  // ── Composer state ──
  const [input, setInputRaw] = useState(() => readJson(sessionStorage, DRAFT_KEY, ""));
  const setInput: typeof setInputRaw = (v) =>
    setInputRaw((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      try {
        sessionStorage.setItem(DRAFT_KEY, JSON.stringify(next));
      } catch {
        /* the draft just won't survive a reload */
      }
      return next;
    });
  const [caret, setCaret] = useState(0);
  const [sendCount, setSendCount] = useState(0);
  const [enhancing, setEnhancing] = useState(false);
  const [enhanceHintVisible, setEnhanceHintVisible] = useState(false);
  const [enhanceAnim, setEnhanceAnim] = useState<{
    oldText: string;
    newText: string | null;
  } | null>(null);
  const [enhancement, setEnhancement] = useState<{
    plain: string;
    segments: PromptSegment[];
  } | null>(null);
  const pendingEnhanceRef = useRef(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastKeystrokeAtRef = useRef(0);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const { runEnhance, onEnhanceAnimDone } = usePromptEnhance({
    input,
    setInput,
    inputRef,
    enhancing,
    setEnhancing,
    setEnhanceHintVisible,
    setEnhanceAnim,
    pendingEnhanceRef,
    enhancement,
    setEnhancement,
    hydrated: true,
    slashOpen: false,
    mentionOpen: false,
    scheduleDraft: false,
  } as Parameters<typeof usePromptEnhance>[0]);

  const attachments: PendingAttachment[] = picked
    ? [
        {
          id: 1,
          kind: "file",
          name: chipName(picked) + (pickMissing ? " · not on this page" : ""),
          mediaType: "text/html",
          data: "",
        },
      ]
    : [];

  const [sendError, setSendError] = useState<string | null>(null);
  const submit = () => {
    const text = input.trim();
    if (!text || !config) return;
    const element =
      picked && !pickMissing
        ? { selector: picked.selector, html: picked.html, tag: picked.tag, text: picked.text }
        : null;
    const url = toDevUrl(pageUrl || config.devUrl, config.devUrl, config.proxyOrigins);
    setSendError(null);
    void sendPrompt(text, [], { livePreview: { url, element } }).catch((err: unknown) => {
      setSendError(typeof err === "string" ? err : String(err));
      setInput(text);
    });
    setInput("");
    setEnhancement(null);
    setSendCount((n) => n + 1);
  };
  // A prompt suggested in a reply (Markdown's "send" links) goes out like a typed one.
  const sendFromReply = (text: string): Promise<boolean> => {
    if (!config) return Promise.resolve(false);
    const url = toDevUrl(pageUrl || config.devUrl, config.devUrl, config.proxyOrigins);
    return sendPrompt(text, [], { livePreview: { url, element: null } }).then(
      () => true,
      () => false,
    );
  };
  const requestCancel = () => {
    setCancelling(true);
    void cancel().catch(() => setCancelling(false));
  };
  const togglePicking = () => {
    const next = !picking;
    setPicking(next);
    bridge.post({ type: "ez-live:picking", on: next });
  };
  // Esc in the chat: with an element picked, drops it and goes back to picking another; in pick
  // mode, leaves it. An open deck menu closes first. It never hides the chat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (picking) {
        e.preventDefault();
        e.stopPropagation();
        setPicking(false);
        bridge.post({ type: "ez-live:picking", on: false });
      } else if (picked) {
        e.preventDefault();
        e.stopPropagation();
        setPicked(null);
        bridge.post({ type: "ez-live:clear-pick" });
        setPicking(true);
        bridge.post({ type: "ez-live:picking", on: true });
      }
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [picking, picked]);

  // Collapsed thread: only the latest exchange. Replies (every row between two of
  // your messages) share one glass bubble; your messages are ezcoder-app's own bubbles.
  const [expanded, setExpanded] = useState(false);
  let from = 0;
  if (!expanded)
    for (let i = items.length - 1; i >= 0; i--)
      if (items[i].kind === "user") {
        from = i;
        break;
      }
  const shown = items.slice(from);
  const earlier = items.slice(0, from).filter((it) => it.kind === "user").length;
  const userCount = items.filter((it) => it.kind === "user").length;
  const groups: Array<{ user: Item } | { rows: Item[] }> = [];
  for (const it of shown) {
    if (it.kind === "user") groups.push({ user: it });
    else {
      const last = groups[groups.length - 1];
      if (last && "rows" in last) last.rows.push(it);
      else groups.push({ rows: [it] });
    }
  }
  const threadRef = useRef<HTMLDivElement>(null);
  const scrollToBottom = useCallback(() => {
    const t = threadRef.current;
    if (t) t.scrollTop = t.scrollHeight;
  }, []);
  useEffect(scrollToBottom, [items, expanded, scrollToBottom]);
  const chatView = useMemo(() => ({ visible: true }), []);
  const entrances = useMemo(() => createEntranceLifetime(0), []);
  const row = (it: Item) => (
    <TranscriptRow
      key={it.id}
      item={it}
      view={chatView}
      animateIn
      consumeEntrance={entrances.consume}
      onContentGrow={scrollToBottom}
    />
  );

  // The preview runs on its own port: say once what that means.
  const [noteSeen, setNoteSeen] = useState(() => localStorage.getItem(NOTE_KEY) === "1");
  const dismissNote = () => {
    localStorage.setItem(NOTE_KEY, "1");
    setNoteSeen(true);
  };

  const noop = () => {};
  return (
    <div className="lp-root" ref={rootRef}>
      {!open && (
        <button
          type="button"
          className="pill"
          aria-label={running ? "Open EZ Coder chat (working)" : "Open EZ Coder chat"}
          onClick={() => {
            setOpen(true);
            focusInput();
          }}
        >
          {running ? (
            <span className="pill-live" aria-hidden />
          ) : (
            <ChatCircleDotsIcon size={16} aria-hidden />
          )}
          <span>{running ? "EZ Coder is working" : "Ask EZ Coder"}</span>
        </button>
      )}
      <section className="dock" aria-label="EZ Coder" hidden={!open}>
        {!noteSeen && (
          <p className="lp-note" role="note">
            This preview has its own port, so sign-ins and saved data won't carry over.
            <button type="button" className="btn btn-sm btn-ghost" onClick={dismissNote}>
              Got it
            </button>
          </p>
        )}
        {sendError && (
          <p className="lp-note" role="alert">
            {sendError}
          </p>
        )}
        {!toolsHidden && (
          <div className="thread" ref={threadRef} aria-live="polite">
            {userCount > 1 && (
              <button
                className="earlier"
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpanded((x) => !x)}
              >
                {expanded
                  ? "Hide earlier messages"
                  : `${earlier} earlier message${earlier === 1 ? "" : "s"}`}
              </button>
            )}
            <PromptSendProvider value={sendFromReply}>
              <LiveTextContext.Provider value={liveText}>
                {groups.map((g) =>
                  "user" in g ? (
                    row(g.user)
                  ) : (
                    <div key={`r${g.rows[0].id}`} className="ez-bubble">
                      {g.rows.map(row)}
                    </div>
                  ),
                )}
              </LiveTextContext.Provider>
            </PromptSendProvider>
          </div>
        )}
        <div className="deck-holder">
          <button
            type="button"
            className="minimise"
            aria-label="Minimise EZ Coder chat"
            title="Minimise"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (picking) togglePicking();
              setOpen(false);
            }}
          >
            <MinusIcon size={13} weight="bold" aria-hidden />
          </button>
          <div className="lp-card">
            {!toolsHidden && <LiveToolPanel entries={liveToolFeed} />}
            <ActivityBar
              running={running}
              runStartedAt={runStartedAt}
              activity={activity}
              cancelling={cancelling}
              tokens={tokens}
              doneStatus={doneStatus}
              isThinking={isThinking}
              thinkingStartTs={thinkingStartTs}
              thinkingAccumMs={thinkingAccumMs}
              toolsHidden={toolsHidden}
              hasToolFeed={liveToolFeed.length > 0 || items.length > 0}
              onToggleTools={() => setToolsHidden((h) => !h)}
              onCancel={requestCancel}
            />
            <Composer
              workspaceMode="code"
              state={state}
              composerRef={composerRef}
              isFileDragOver={false}
              scheduleInvalid={false}
              scheduleDraft={false}
              running={running}
              nolanRunning={false}
              autopilotReviewing={false}
              cancelling={cancelling}
              sendDisabled={!input.trim() || !config}
              windowFocused
              input={input}
              setInput={setInput}
              caret={caret}
              setCaret={setCaret}
              fillScheduleInterval={noop}
              slashOpen={false}
              slashMatches={[]}
              clampedSlashIndex={0}
              pickSlashCommand={noop}
              setSlashIndex={noop}
              mentionOpen={false}
              fileMatches={[]}
              clampedFileIndex={0}
              mention={null}
              setMention={noop}
              pickMentionFile={noop}
              setFileIndex={noop}
              updateMention={noop}
              attachments={attachments}
              attachmentsLoading={false}
              removeAttachment={() => {
                setPicked(null);
                bridge.post({ type: "ez-live:clear-pick" });
                focusInput();
              }}
              addFiles={async () => {}}
              fileInputRef={fileInputRef}
              mentionedPaths={[]}
              removeMentionChip={noop}
              visibleQueuedMessages={[]}
              handleCancelQueued={noop}
              sendCount={sendCount}
              enhanceAnim={enhanceAnim}
              onEnhanceAnimDone={onEnhanceAnimDone}
              enhancement={enhancement}
              setEnhancement={setEnhancement}
              enhancing={enhancing}
              enhanceHintVisible={enhanceHintVisible}
              runEnhance={runEnhance}
              nolanActive={false}
              shellMode={false}
              shellMenu={null}
              nolanInputParts={null}
              attachInput={(el) => {
                inputRef.current = el;
              }}
              displayPlaceholder={picked ? "Ask EZ Coder about this element…" : "Ask EZ Coder…"}
              lastKeystrokeAtRef={lastKeystrokeAtRef}
              historyIndex={historyIndex}
              setHistoryIndex={setHistoryIndex}
              navigateHistory={() => false}
              submit={submit}
              requestCancel={requestCancel}
              leadAction={
                <button
                  type="button"
                  className="icon-circle pick-toggle"
                  aria-pressed={picking}
                  aria-label={picking ? "Stop picking" : "Pick an element on the page"}
                  title={
                    picking
                      ? "Picking: click elements on the page. Esc or click here to stop"
                      : "Pick an element"
                  }
                  // Keep focus in the text box, so Esc never leaves a focus ring on this button.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={togglePicking}
                >
                  <CursorClickIcon size={15} />
                </button>
              }
            />
          </div>
        </div>
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LiveApp />
  </StrictMode>,
);
