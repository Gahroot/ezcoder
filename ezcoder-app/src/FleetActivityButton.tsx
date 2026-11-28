import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DesktopTowerIcon } from "@phosphor-icons/react";
import {
  getFleetLog,
  type FleetActivity,
  type FleetActivityJob,
  type FleetActivityService,
} from "./agent";
import { FloatingSurface } from "./FloatingSurface";
import { Modal } from "./Modal";
import { useAnchoredPopover, useScrollEdges } from "./popover";
import { theme } from "./theme";
import { isLiveFleetJob, useFleetActivity } from "./use-fleet";
import "./Machines.css";

const JOB_STATE: Record<FleetActivityJob["state"], string> = {
  queued: "Waiting for a machine",
  preparing: "Getting ready",
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  error: "Couldn't run",
  cancelled: "Stopped",
};

const SERVICE_STATE: Record<FleetActivityService["state"], string> = {
  starting: "Starting",
  running: "Running",
  stopped: "Stopped",
  error: "Stopped with a problem",
};

type LogTarget = { kind: "job" | "service"; id: string; name: string };

/** The last lines of a fleet job's or service's log, with Refresh. */
export function FleetLogModal({
  target,
  onClose,
}: {
  target: LogTarget;
  onClose: () => void;
}): React.ReactElement {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      setText(await getFleetLog(target.kind, target.id, 200));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void load();
    // Load once per target; Refresh reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.kind, target.id]);

  return (
    <Modal title={`Log: ${target.name}`} onClose={onClose} className="machine-modal">
      <div className="modal-hint" style={{ color: theme.textMuted }}>
        The last 200 lines.
      </div>
      {error ? (
        <div className="modal-error" role="alert" style={{ color: theme.error }}>
          {error}
        </div>
      ) : (
        <pre className="machine-log" aria-label="Log">
          {text === null ? "Loading\u2026" : text || "Nothing in the log yet."}
        </pre>
      )}
      <div className="modal-actions">
        <button className="modal-btn" onClick={() => void load()}>
          Refresh
        </button>
        <button className="modal-btn primary" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

/**
 * Footer indicator for work running on other machines (D3): fleet jobs and
 * services of this project, live, each with its machine and a View log button.
 * Hidden while nothing runs there.
 */
export function FleetActivityButton({
  activity: injected,
}: {
  /** Tests pass fixed activity; the app polls. */
  activity?: FleetActivity;
}): React.ReactElement {
  const polled = useFleetActivity(injected === undefined);
  const activity = injected ?? polled;
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<LogTarget | null>(null);
  const { anchorRef, popoverRef, style } = useAnchoredPopover<HTMLButtonElement, HTMLDivElement>(
    open,
    () => setOpen(false),
    "above",
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useScrollEdges(scrollRef, open);
  const headingId = useId();
  const popoverId = useId();

  const jobs = activity.jobs.filter(isLiveFleetJob);
  const services = activity.services.filter((s) => s.state === "starting" || s.state === "running");
  const count = jobs.length + services.length;
  useEffect(() => {
    if (count === 0) setOpen(false);
  }, [count]);

  const row = (
    key: string,
    name: string,
    meta: string,
    target: LogTarget,
    index: number,
  ): React.ReactElement => (
    <li key={key} className="pop-row pop-item" style={{ "--i": index } as React.CSSProperties}>
      <span className="pop-item-text">
        <span className="pop-item-main">{name}</span>
        <span className="pop-item-meta">{meta}</span>
      </span>
      <button
        type="button"
        className="pop-item-action"
        aria-label={`View log of ${name}`}
        onClick={() => {
          setOpen(false);
          setLog(target);
        }}
      >
        View log
      </button>
    </li>
  );

  return (
    <>
      {count > 0 && (
        <span className="bgtasks">
          <button
            ref={anchorRef}
            className="bgtasks-button"
            style={{ color: theme.info, borderColor: theme.border }}
            title="Work on other machines"
            aria-expanded={open}
            aria-controls={open ? popoverId : undefined}
            data-open={open || undefined}
            onClick={() => setOpen((o) => !o)}
          >
            <DesktopTowerIcon className="bgtasks-icon" size={13} weight="bold" aria-hidden="true" />
            {count} on other machines
          </button>
        </span>
      )}
      {createPortal(
        <FloatingSurface>
          {open && count > 0 && (
            <div
              ref={popoverRef}
              id={popoverId}
              className="pop-panel bgtasks-menu"
              data-side="above"
              role="dialog"
              aria-labelledby={headingId}
              style={style}
            >
              <header className="pop-head">
                <h2 id={headingId} className="pop-title">
                  On other machines
                </h2>
                <span className="pop-count">
                  {jobs.length} job{jobs.length === 1 ? "" : "s"}
                  {services.length > 0 &&
                    ` \u00b7 ${services.length} service${services.length === 1 ? "" : "s"}`}
                </span>
              </header>
              <div
                ref={scrollRef}
                className="pop-scroll pop-body"
                tabIndex={-1}
                data-pop-focus
                onScroll={onScroll}
              >
                <ul className="pop-list">
                  {jobs.map((j, i) =>
                    row(
                      `job-${j.id}`,
                      j.name,
                      `${JOB_STATE[j.state] ?? j.state}${j.node ? ` on ${j.node}` : ""}`,
                      { kind: "job", id: j.id, name: j.name },
                      i,
                    ),
                  )}
                  {services.map((s, i) =>
                    row(
                      `svc-${s.id}`,
                      s.name,
                      `${SERVICE_STATE[s.state] ?? s.state} on ${s.node}`,
                      { kind: "service", id: s.id, name: s.name },
                      jobs.length + i,
                    ),
                  )}
                </ul>
              </div>
            </div>
          )}
        </FloatingSurface>,
        document.body,
      )}
      {log && <FleetLogModal target={log} onClose={() => setLog(null)} />}
    </>
  );
}
