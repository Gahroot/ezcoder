import type { DoctorCheck, DoctorReport } from "./agent";

const CHECK_NAMES: Record<string, string> = {
  tailscale: "Network",
  docker: "Docker",
  gpu: "Graphics card",
  git: "Code access",
  model_login: "Model login",
  disk: "Disk space",
  version: "EZ Coder version",
  slots: "Room for work",
  keychain: "Secret storage",
};

const STATUS_WORDS: Record<DoctorCheck["status"], string> = {
  ok: "Fine",
  warn: "Worth a look",
  fail: "Needs fixing",
  skip: "Not checked",
};

/** A machine's checks, one line each, with the fix under anything not fine. */
export function DoctorLines({ report }: { report: DoctorReport }): React.ReactElement {
  return (
    <div className="machine-doctor">
      <p className="machine-doctor-summary" role="status">
        {report.ok
          ? `${report.node} is ready to take work.`
          : `${report.node} needs a fix before it can take all work.`}
      </p>
      <ul className="machine-doctor-list">
        {report.checks.map((check) => (
          <li key={check.id} className="machine-doctor-line" data-status={check.status}>
            <span className="machine-doctor-dot" aria-hidden="true" />
            <span className="machine-doctor-text">
              <span className="machine-doctor-name">
                {CHECK_NAMES[check.id] ?? check.id}
                <span className="sr-only">: {STATUS_WORDS[check.status]}.</span>
              </span>{" "}
              <span className="machine-doctor-detail">{check.detail}</span>
              {check.fix && (check.status === "warn" || check.status === "fail") && (
                <span className="machine-doctor-fix">
                  To fix: <code>{check.fix}</code>
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
