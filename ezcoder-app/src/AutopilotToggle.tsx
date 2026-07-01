/**
 * Autopilot toggle — the Material-style switch (Uiverse by lenin55) that turns
 * auto-review on/off for THIS window's project. Sits left of the "+ New" button
 * in the nav row. State lives on the sidecar (persisted per-cwd in ezcoder-app.json);
 * this is a controlled switch that optimistically flips then fires `setAutopilot`.
 *
 * Markup mirrors the source snippet exactly (label.cl-switch > input + span);
 * the styling lives in `.cl-switch` rules in App.css, re-themed to the app's
 * accent so the "on" track/thumb read as ezcoder purple, not the original teal.
 */
interface Props {
  /** Current on/off state (from the sidecar's AgentState). */
  checked: boolean;
  /** Fired with the next value when the user flips the switch. */
  onChange: (next: boolean) => void;
}

export function AutopilotToggle({ checked, onChange }: Props): React.ReactElement {
  return (
    <span
      className="autopilot-toggle"
      title="Autopilot: after each run, auto-review the work and continue if adjustments are needed"
    >
      <span className="autopilot-label">Autopilot</span>
      <span className="cl-toggle-switch">
        <label className="cl-switch">
          <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
          <span />
        </label>
      </span>
    </span>
  );
}
