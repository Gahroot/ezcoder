import { useId, useState } from "react";
import { addMachine, type AddMachineResult } from "./agent";
import { DoctorLines } from "./DoctorLines";
import { Modal } from "./Modal";
import { ModalDismissButton } from "./modal-embed";
import { oneLiner, PLATFORM_SETUP, type SetupPlatform } from "./machine-setup";
import { theme } from "./theme";
import { toast } from "./toast";
import "./Machines.css";

interface Props {
  onClose: () => void;
  /** A machine was paired (the panel refreshes). */
  onAdded: (result: AddMachineResult) => void;
  /** Which tab opens first. */
  initialPlatform?: SetupPlatform;
}

function copy(text: string): void {
  void navigator.clipboard
    ?.writeText(text)
    .then(() => toast("Copied.", "success"))
    .catch(() => toast("Couldn't copy to the clipboard.", "error"));
}

/**
 * Add a machine (D2): what to run on the other computer, per platform, then
 * the pairing code or text it prints. Pairing runs the machine's checks and
 * shows them line by line, each problem with its fix.
 */
export function AddMachineModal({
  onClose,
  onAdded,
  initialPlatform = "linux",
}: Props): React.ReactElement {
  const [platform, setPlatform] = useState<SetupPlatform>(initialPlatform);
  const [pairing, setPairing] = useState("");
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AddMachineResult | null>(null);
  const tabsId = useId();
  const inputId = useId();
  const setup = PLATFORM_SETUP.find((p) => p.id === platform) ?? PLATFORM_SETUP[0]!;

  async function submit(): Promise<void> {
    if (busy || !pairing.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await addMachine(pairing.trim(), offline);
      setResult(res);
      onAdded(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <Modal title={`Added ${result.name}`} onClose={onClose} className="machine-modal">
        {result.doctor ? (
          <DoctorLines report={result.doctor} />
        ) : (
          <div className="modal-hint" style={{ color: theme.textSecondary }}>
            {result.online
              ? `${result.name} is paired. Its checks couldn't run just now; try Check again from the list.`
              : `${result.name} is saved, but it's off right now. It shows up as ready once it's back on.`}
          </div>
        )}
        <div className="modal-actions">
          <button className="modal-btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Add a machine" onClose={onClose} className="machine-modal">
      <div className="modal-hint" style={{ color: theme.textSecondary }}>
        On the other computer, open a terminal and run these. It can then take builds, tests and
        helper agents from this computer.
      </div>
      <div className="machine-tabs" role="tablist" aria-label="The other computer runs">
        {PLATFORM_SETUP.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            id={`${tabsId}-${p.id}`}
            aria-selected={p.id === platform}
            aria-controls={`${tabsId}-panel`}
            className="machine-tab"
            onClick={() => setPlatform(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div
        id={`${tabsId}-panel`}
        role="tabpanel"
        aria-labelledby={`${tabsId}-${platform}`}
        className="machine-setup"
      >
        <p className="machine-setup-needs">{setup.needs}</p>
        <ol className="machine-steps">
          {setup.steps.map((step) => (
            <li key={step.command} className="machine-step">
              <span className="machine-step-label">{step.label}</span>
              <span className="machine-step-row">
                <code className="machine-command">{step.command}</code>
                <button
                  type="button"
                  className="pop-item-action"
                  aria-label={`Copy: ${step.command}`}
                  onClick={() => copy(step.command)}
                >
                  Copy
                </button>
              </span>
            </li>
          ))}
        </ol>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => copy(oneLiner(setup))}
        >
          Copy all as one line
        </button>
      </div>
      <label className="modal-label" htmlFor={inputId} style={{ color: theme.textMuted }}>
        Code or pairing text from the other computer
      </label>
      <input
        id={inputId}
        className="modal-input"
        placeholder="K7QM-2XPA or ezfleet://…"
        value={pairing}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setPairing(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
      />
      <label className="machine-check">
        <input type="checkbox" checked={offline} onChange={(e) => setOffline(e.target.checked)} />
        Add it even if it's off right now
      </label>
      {error && (
        <div className="modal-error" role="alert" style={{ color: theme.error }}>
          {error}
        </div>
      )}
      <div className="modal-actions">
        <ModalDismissButton onClick={onClose}>Cancel</ModalDismissButton>
        <button
          className="modal-btn primary"
          disabled={busy || !pairing.trim()}
          onClick={() => void submit()}
        >
          {busy ? "Checking the machine\u2026" : "Add machine"}
        </button>
      </div>
    </Modal>
  );
}
