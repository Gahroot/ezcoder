import { useEffect, useState } from "react";
import { theme } from "./theme";
import { SPINNER_FRAMES, SPINNER_FRAME_MS } from "./ActivityBar";

interface Props {
  /** Stop the in-flight autopilot review (reuses the shared /cancel path). */
  onCancel: () => void;
}

/**
 * Autopilot review status row. Shown in the activity-bar region (not the
 * transcript) while Nolan is silently auto-reviewing EZ Coder's just-finished
 * turn — same braille spinner + statusrow layout as the run/Nolan bars, tinted to
 * Nolan and labelled "Nolan reviewing…". No timer/tokens: the review is short and
 * its verdict lands as a Nolan bubble, so this is a pure activity indicator.
 */
export function AutopilotReviewBar({ onCancel }: Props): React.ReactElement {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const spin = setInterval(
      () => setFrame((f) => (f + 1) % SPINNER_FRAMES.length),
      SPINNER_FRAME_MS,
    );
    return () => clearInterval(spin);
  }, []);

  return (
    <div className="statusrow running nolan-statusrow" style={{ color: theme.textMuted }}>
      <span className="statusrow-left">
        <span className="statusrow-icon spinner nolan-spinner" style={{ color: theme.ken }}>
          {SPINNER_FRAMES[frame]}
        </span>
        <span className="working" style={{ color: theme.ken }}>
          {"Nolan reviewing\u2026"}
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
