import { useState } from "react";
import {
  checkMachine,
  removeMachine,
  rotateMachineToken,
  shareMachineLogin,
  type DoctorReport,
  type Machine,
  type MachineCapacity,
} from "./agent";
import { AddMachineModal } from "./AddMachineModal";
import { Badge } from "./Badge";
import { ConfirmModal } from "./ConfirmModal";
import { DoctorLines } from "./DoctorLines";
import { Modal } from "./Modal";
import { SettingsCard } from "./settings-section";
import { SettingsHeaderAction, SettingsHeaderStatus } from "./settings-header";
import { theme } from "./theme";
import { toast } from "./toast";
import { useMachines, type MachinesState } from "./use-fleet";
import "./Machines.css";

const PLATFORM_NAMES: Record<string, string> = {
  linux: "Linux",
  wsl2: "Windows (WSL2)",
  macos: "macOS",
  windows: "Windows",
};

/** "3 of 8 in use" */
export function slotsText(c: Pick<MachineCapacity, "slots" | "slotsUsed">): string {
  return `${c.slotsUsed} of ${c.slots} in use`;
}

/** The command that changes a machine's slots, run on that machine. */
export const SLOTS_COMMAND = "ezcoder node config --slots N";

export function loadText(load: number | undefined): string | null {
  if (load === undefined || !Number.isFinite(load)) return null;
  return `${Math.round(Math.min(load, 9.99) * 100)}% busy`;
}

export function runningText(m: Machine): string {
  const parts: string[] = [];
  const say = (n: number, one: string, many: string) => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  say(m.running.jobs, "job", "jobs");
  say(m.running.agents, "helper agent", "helper agents");
  say(m.running.services, "service", "services");
  return parts.length ? parts.join(", ") : "Nothing";
}

type Pending =
  | { kind: "remove" | "rotate" | "share" | "replace-login"; machine: Machine }
  | { kind: "doctor"; report: DoctorReport };

const CONFIRM = {
  remove: (n: string) => ({
    title: `Remove ${n}?`,
    message: `This computer stops sending work to ${n}. Work already running there is left alone. EZ Coder stays installed on ${n}; you can add it again later with a new code.`,
    confirmLabel: "Remove",
  }),
  rotate: (n: string) => ({
    title: `Give ${n} a new key?`,
    message: `${n} gets a new key and the old one stops working straight away. This computer switches to the new key by itself. Anything else that was paired with the old pairing text has to pair again.`,
    confirmLabel: "Give it a new key",
  }),
  share: (n: string) => ({
    title: `Share your model login with ${n}?`,
    message: `This copies the AI provider logins on this computer to ${n}, so helper agents can run there. Anyone who can use that machine's account can then use them. A subscription login that ${n} refreshes first may sign this computer out. Signing in on ${n} itself (\`ezcoder login\`) is safer.`,
    confirmLabel: "Share login",
  }),
  "replace-login": (n: string) => ({
    title: `Replace ${n}'s own login?`,
    message: `${n} already has its own model login. Sharing now replaces it with this computer's logins.`,
    confirmLabel: "Replace it",
  }),
};

function MachineRow({
  machine,
  onAction,
  onCheck,
  checking,
}: {
  machine: Machine;
  onAction: (kind: "remove" | "rotate" | "share", m: Machine) => void;
  onCheck: (m: Machine) => void;
  checking: boolean;
}): React.ReactElement {
  const m = machine;
  const load = loadText(m.load);
  const version = m.notices.some((n) => n.kind === "update" || n.kind === "protocol");
  return (
    <li className="machine-row" aria-label={m.name}>
      <div className="machine-row-head">
        <h4 className="machine-name">{m.name}</h4>
        <Badge color={m.online ? theme.success : undefined}>
          {m.online ? "Online" : "Offline"}
        </Badge>
        {version && (
          <Badge color={theme.warning} className="machine-badge">
            Update needed
          </Badge>
        )}
        <span className="machine-address">{m.address}</span>
      </div>
      <dl className="machine-facts">
        {m.slots !== undefined && (
          <div>
            <dt>Slots</dt>
            <dd>{slotsText({ slots: m.slots, slotsUsed: m.slotsUsed ?? 0 })}</dd>
          </div>
        )}
        {load && (
          <div>
            <dt>Load</dt>
            <dd>{load}</dd>
          </div>
        )}
        <div>
          <dt>Graphics</dt>
          <dd>
            {m.gpus.length
              ? m.gpus.map((g) => `${g.name} (${Math.round(g.memoryGb)} GB)`).join(", ")
              : "None"}
          </dd>
        </div>
        <div>
          <dt>Running</dt>
          <dd>{runningText(m)}</dd>
        </div>
        {m.platform && (
          <div>
            <dt>System</dt>
            <dd>{PLATFORM_NAMES[m.platform] ?? m.platform}</dd>
          </div>
        )}
        {m.version && (
          <div>
            <dt>EZ Coder</dt>
            <dd>{m.version}</dd>
          </div>
        )}
      </dl>
      {m.notices.map((n) => (
        <p key={n.kind} className="machine-notice" data-kind={n.kind}>
          {n.text}
        </p>
      ))}
      <p className="machine-setup-needs">
        To change how much work it takes at once, run <code>{SLOTS_COMMAND}</code> on {m.name}.
      </p>
      <div className="machine-actions">
        <button
          type="button"
          className="pop-item-action"
          disabled={checking || !m.online}
          onClick={() => onCheck(m)}
        >
          {checking ? "Checking\u2026" : "Check"}
        </button>
        <button
          type="button"
          className="pop-item-action"
          disabled={!m.online}
          onClick={() => onAction("share", m)}
        >
          Share model login
        </button>
        <button
          type="button"
          className="pop-item-action"
          disabled={!m.online}
          onClick={() => onAction("rotate", m)}
        >
          New key
        </button>
        <button type="button" className="pop-item-action" onClick={() => onAction("remove", m)}>
          Remove
        </button>
      </div>
    </li>
  );
}

/**
 * Machines (D1, D5): the other computers this one sends work to, with how
 * busy each is and what it runs, plus the total room for work across all of
 * them. Add a machine (D2) sits in the header bar.
 */
export function MachinesPanel({
  state: injected,
}: {
  /** Tests pass a fixed state; the app polls. */
  state?: MachinesState;
}): React.ReactElement {
  const polled = useMachines();
  const { machines, local, total, loading, error, refresh } = injected ?? polled;
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);

  async function check(m: Machine): Promise<void> {
    setChecking(m.name);
    try {
      setPending({ kind: "doctor", report: await checkMachine(m.name) });
    } catch (e) {
      toast(`Couldn't check ${m.name}: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setChecking(null);
    }
  }

  async function confirm(): Promise<void> {
    if (!pending || pending.kind === "doctor" || busy) return;
    const { kind, machine } = pending;
    setBusy(true);
    try {
      if (kind === "remove") {
        await removeMachine(machine.name);
        toast(`Removed ${machine.name}.`, "success");
      } else if (kind === "rotate") {
        await rotateMachineToken(machine.name);
        toast(`${machine.name} has a new key.`, "success");
      } else {
        const res = await shareMachineLogin(machine.name, kind === "replace-login");
        if (res.status === "exists") {
          setPending({ kind: "replace-login", machine });
          return;
        }
        toast(`Shared your model login with ${machine.name}.`, "success");
      }
      setPending(null);
      await refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
      setPending(null);
    } finally {
      setBusy(false);
    }
  }

  const online = machines.filter((m) => m.online).length;

  return (
    <>
      <SettingsHeaderStatus>
        <Badge color={online > 0 ? theme.success : undefined}>
          {machines.length === 0 ? "None yet" : `${online} of ${machines.length} online`}
        </Badge>
      </SettingsHeaderStatus>
      <SettingsHeaderAction>
        <button className="btn btn-primary btn-sm" type="button" onClick={() => setAdding(true)}>
          Add a machine
        </button>
      </SettingsHeaderAction>
      <div className="settings-col">
        <SettingsCard
          title="Room for work"
          description="Each slot runs one job or helper agent at a time, here or on another machine."
        >
          {total && local ? (
            <dl className="machine-facts" aria-label="Room for work">
              <div>
                <dt>All machines</dt>
                <dd>{slotsText(total)}</dd>
              </div>
              <div>
                <dt>This computer</dt>
                <dd>
                  {slotsText(local)}
                  {local.estimated ? " (estimated)" : ""}
                </dd>
              </div>
              {machines.map((m) => (
                <div key={m.name}>
                  <dt>{m.name}</dt>
                  <dd>
                    {m.online && m.slots !== undefined
                      ? slotsText({ slots: m.slots, slotsUsed: m.slotsUsed ?? 0 })
                      : "Offline"}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="machine-empty">{loading ? "Looking\u2026" : "Not known yet."}</p>
          )}
        </SettingsCard>
        <SettingsCard
          title="Your machines"
          description="Other computers you own that can take builds, tests and helper agents from this one."
        >
          {error && (
            <div className="modal-error" role="alert" style={{ color: theme.error }}>
              Couldn't read your machines: {error}
            </div>
          )}
          {!loading && machines.length === 0 && !error ? (
            <p className="machine-empty">
              No other machines yet. Add a spare computer (a gaming PC, an old Mac, a home server)
              and EZ Coder can send long builds, tests and helper agents there while you keep
              working.
            </p>
          ) : (
            <ul className="machine-list">
              {machines.map((m) => (
                <MachineRow
                  key={m.name}
                  machine={m}
                  checking={checking === m.name}
                  onCheck={(x) => void check(x)}
                  onAction={(kind, x) => setPending({ kind, machine: x })}
                />
              ))}
            </ul>
          )}
        </SettingsCard>
      </div>
      {adding && (
        <AddMachineModal onClose={() => setAdding(false)} onAdded={() => void refresh()} />
      )}
      {pending?.kind === "doctor" && (
        <Modal title={`Checks for ${pending.report.node}`} onClose={() => setPending(null)}>
          <DoctorLines report={pending.report} />
          <div className="modal-actions">
            <button className="modal-btn primary" onClick={() => setPending(null)}>
              Done
            </button>
          </div>
        </Modal>
      )}
      {pending && pending.kind !== "doctor" && (
        <ConfirmModal
          {...CONFIRM[pending.kind](pending.machine.name)}
          busy={busy}
          onConfirm={() => void confirm()}
          onClose={() => setPending(null)}
        />
      )}
    </>
  );
}
