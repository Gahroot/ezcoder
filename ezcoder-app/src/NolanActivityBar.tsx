import { useEffect, useId, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";
import { theme } from "./theme";
import { formatTokenCount } from "./ActivityBar";
import { ShimmerText } from "./ShimmerText";

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r > 0 ? `${m}m ${r}s` : `${m}m`;
}

interface Props {
  /** Timestamp (ms) Nolan's run began, or null when not running. */
  runStartTs: number | null;
  /** Accumulated output tokens for Nolan's current run. */
  tokens: number;
  /** True while Nolan is actively emitting reasoning/thinking. */
  isThinking: boolean;
  /** Timestamp (ms) Nolan's current thinking span began, or null. */
  thinkingStartTs: number | null;
  /** Completed thinking time (ms) from earlier spans in this run. */
  thinkingAccumMs: number;
  onCancel: () => void;
}

/**
 * Nolan Grout's activity bar. A 1:1 mirror of the EZ Coder ActivityBar's running row
 * — same listening orb, same `(elapsed · ↓ N tokens · thinking for Xs)` meta,
 * same statusrow layout + esc-to-cancel — just tinted to Nolan and labelled "Nolan
 * is thinking…". Stacks above the main bar while Nolan runs concurrently, so its
 * own top border is dropped (the main bar keeps the divider).
 */
export function NolanActivityBar({
  runStartTs,
  tokens,
  isThinking,
  thinkingStartTs,
  thinkingAccumMs,
  onCancel,
}: Props): React.ReactElement {
  const orbTintId = useId();
  // `now` is bumped every 250ms; the elapsed + thinking timers are derived from
  // it + the start timestamps, mirroring the ActivityBar's live-tick approach
  // without reading a ref during render.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => {
      clearInterval(tick);
    };
  }, []);

  const elapsed = runStartTs ? now - runStartTs : 0;
  const liveThinkingDelta = isThinking && thinkingStartTs ? now - thinkingStartTs : 0;
  const thinkingMs = thinkingAccumMs + liveThinkingDelta;
  const thinkingLabel = isThinking
    ? thinkingMs >= 1000
      ? `thinking for ${formatElapsed(thinkingMs)}`
      : "thinking"
    : thinkingMs >= 1000
      ? `thought for ${formatElapsed(thinkingMs)}`
      : "";

  const meta: { text: string; thinking?: boolean }[] = [{ text: formatElapsed(elapsed) }];
  if (tokens > 0) meta.push({ text: `\u2193 ${formatTokenCount(tokens)} tokens` });
  if (thinkingLabel) meta.push({ text: thinkingLabel, thinking: true });

  return (
    <div className="statusrow running nolan-statusrow" style={{ color: theme.textMuted }}>
      <span className="statusrow-left">
        {/* Tint the canvas alpha with Nolan's existing color; the package has no color prop. */}
        <svg width="0" height="0" aria-hidden="true" style={{ position: "absolute" }}>
          <defs>
            <filter id={orbTintId} colorInterpolationFilters="sRGB">
              <feFlood floodColor={theme.nolan} />
              <feComposite in2="SourceAlpha" operator="in" />
            </filter>
          </defs>
        </svg>
        <ThinkingOrb
          state="listening"
          size={20}
          theme="dark"
          aria-hidden="true"
          style={{ flexShrink: 0, filter: `url(#${orbTintId})` }}
        />
        <span style={{ color: theme.nolan }}>
          <ShimmerText base={theme.nolan} bright={theme.text}>
            {"Nolan is thinking…"}
          </ShimmerText>
        </span>
        <span style={{ color: theme.textMuted }}>
          {"("}
          {meta.map((part, i) => (
            <span key={i}>
              {i > 0 ? " \u2022 " : ""}
              <span
                style={{
                  color: part.thinking
                    ? isThinking
                      ? theme.nolan
                      : theme.textMuted
                    : theme.textMuted,
                }}
              >
                {part.text}
              </span>
            </span>
          ))}
          {")"}
        </span>
      </span>
      <span className="statusrow-right">
        <button className="cancel" style={{ color: theme.error }} onClick={onCancel}>
          esc to cancel
        </button>
      </span>
    </div>
  );
}
