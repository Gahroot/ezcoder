import { useState } from "react";
import type { LivePreview } from "./useLivePreview";

/**
 * Live preview controls: the project's running web app in the browser, with
 * EZ Coder's chat on it. Shows the link while it runs. When no dev server runs
 * for the project, the agent starts one; typing an address is the fallback.
 */
export function LivePreviewPanel({
  preview,
  onStartDevServer,
}: {
  preview: LivePreview;
  /** Asks this window's agent to start the project's dev server and open the preview. */
  onStartDevServer?: () => void;
}): React.ReactElement {
  const { status, busy, error, needsUrl } = preview;
  const [address, setAddress] = useState("");
  const [typing, setTyping] = useState(false);
  const running = Boolean(status?.running && status.url);
  const shown = bare(status?.target ?? "") || "your dev server";
  const note = busy
    ? "Looking for this project's dev server…"
    : running
      ? `Shows ${shown}. Right-click anything on the page to ask EZ Coder about it, in a chat of its own.`
      : error && !needsUrl
        ? error
        : needsUrl && onStartDevServer
          ? "EZ Coder starts it in the background, then opens the preview in your browser."
          : null;
  return (
    <div className="livepreview-panel">
      <div className="livepreview-row">
        {running && status?.url ? (
          <>
            <span className="livepreview-main livepreview-url" title={status.url}>
              {bare(status.url)}
            </span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={preview.open}>
              Open
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy}
              onClick={() => void preview.stop()}
            >
              Stop
            </button>
          </>
        ) : (
          <>
            <span className="livepreview-main">
              {needsUrl ? "No web app running" : "Your app, with EZ Coder's chat"}
            </span>
            {needsUrl && onStartDevServer ? (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={busy}
                onClick={onStartDevServer}
              >
                Start dev server
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={busy}
                onClick={() => void preview.start()}
              >
                Open
              </button>
            )}
            {!typing && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setTyping(true)}
              >
                Other address
              </button>
            )}
          </>
        )}
      </div>
      {note && (
        <p className="livepreview-note" role={error && !needsUrl && !busy ? "alert" : "status"}>
          {note}
        </p>
      )}
      {!running && typing && (
        <form
          className="livepreview-field"
          onSubmit={(e) => {
            e.preventDefault();
            if (address.trim()) void preview.start(address.trim());
          }}
        >
          <input
            type="text"
            aria-label="Dev server address"
            placeholder="Dev server address, e.g. localhost:3000"
            value={address}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoFocus
            onChange={(e) => setAddress(e.target.value)}
          />
          <button type="submit" className="btn btn-sm btn-ghost" disabled={busy || !address.trim()}>
            Open
          </button>
        </form>
      )}
    </div>
  );
}

/** An address as people say it: localhost:5173, not http://localhost:5173/. */
function bare(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}
