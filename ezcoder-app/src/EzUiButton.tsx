import { Sparkles } from "lucide-react";
import { theme } from "./theme";
import { setEzUiEnabled, useEzUiEnabled } from "./ez-ui";

export function EzUiButton(): React.ReactElement {
  const on = useEzUiEnabled();
  return (
    <button
      className="modal-btn"
      aria-pressed={on}
      title={on ? "Use the original button styling" : "Use the metallic button styling"}
      style={on ? undefined : { color: theme.textMuted }}
      onClick={() => setEzUiEnabled(!on)}
    >
      <Sparkles size={16} aria-hidden="true" />
      EZ UI {on ? "on" : "off"}
    </button>
  );
}
