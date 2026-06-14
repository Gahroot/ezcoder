import { useEffect, useState } from "react";
import { Settings, Download } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AsciiLogo } from "./AsciiLogo";
import { MemeLayer } from "./MemeLayer";
import { SettingsModal } from "./SettingsModal";
import { waitForReady, getSettings, authStatus } from "./agent";
import { useAppUpdate } from "./update";
import { toast } from "./toast";

interface Props {
  onProjects: () => void;
  onLogin: () => void;
}

/**
 * App entry screen: the shimmering GG Coder banner over the primary actions.
 * "Your Projects" requires two prerequisites — a configured project folder AND
 * at least one connected AI provider — and is dimmed until both are met, with
 * toasts guiding the user. Settings (project folder) lives here, beside Projects.
 */
export function HomeScreen({ onProjects, onLogin }: Props): React.ReactElement {
  const [folderSet, setFolderSet] = useState(false);
  const [providerCount, setProviderCount] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const appUpdate = useAppUpdate();

  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  async function refresh(): Promise<void> {
    await waitForReady();
    const [settings, providers] = await Promise.all([getSettings(), authStatus()]);
    // Prefer the explicit `configured` flag; fall back to a non-empty root so an
    // older sidecar (one that predates the flag) degrades to "set" instead of
    // dimming forever.
    setFolderSet(settings?.configured ?? Boolean(settings?.projectsRoot));
    setProviderCount(providers.filter((p) => p.connected).length);
  }

  useEffect(() => {
    void refresh().catch(() => {});
    // Re-check when the window regains focus so a folder/provider set elsewhere
    // (or after a sidecar respawn) reflects without an app restart.
    const onFocus = (): void => void refresh().catch(() => {});
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const ready = folderSet && providerCount > 0;

  function handleProjects(): void {
    if (ready) {
      onProjects();
      return;
    }
    // Guide the user to the missing prerequisite(s).
    if (!folderSet) {
      toast("Set a project folder first. Open Settings.", "warning");
    }
    if (providerCount === 0) {
      toast("Connect an AI provider first.", "warning");
    }
  }

  return (
    <div className="home" data-tauri-drag-region>
      <MemeLayer />
      {appUpdate.phase === "available" || appUpdate.phase === "installing" ? (
        <button
          className="home-update"
          disabled={appUpdate.phase === "installing"}
          title={`Update to ${appUpdate.version} — installs and restarts the app`}
          onClick={() => void appUpdate.install()}
        >
          <Download size={14} strokeWidth={2.25} aria-hidden="true" />
          {appUpdate.phase === "installing" ? "Installing\u2026" : `Update to ${appUpdate.version}`}
        </button>
      ) : (
        version && <span className="home-version">{`v${version}`}</span>
      )}
      <AsciiLogo />
      <div className="home-tagline">Cause the other coding agents piss me off</div>
      <div className="home-byline">
        By Ken Kai
        <span className="home-byline-sep">{"\u00b7"}</span>
        <a
          className="home-link"
          href="https://skool.com/kenkai"
          onClick={(e) => {
            e.preventDefault();
            void openUrl("https://skool.com/kenkai");
          }}
        >
          Skool
        </a>
        <span className="home-byline-sep">{"\u00b7"}</span>
        <a
          className="home-link"
          href="https://youtube.com/@kenkaidoesai"
          onClick={(e) => {
            e.preventDefault();
            void openUrl("https://youtube.com/@kenkaidoesai");
          }}
        >
          YouTube
        </a>
      </div>
      <div className="home-actions">
        <div className="home-projects-row">
          <button
            className={`btn btn-primary btn-lg home-btn${ready ? "" : " is-dimmed"}`}
            aria-disabled={!ready}
            onClick={handleProjects}
          >
            Your Projects
          </button>
          <button
            className="btn btn-ghost btn-icon home-settings"
            title="Settings"
            onClick={() => setShowSettings(true)}
          >
            <Settings size={20} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        <button className="btn btn-ghost btn-lg home-btn" onClick={onLogin}>
          Login to AI Providers
        </button>
      </div>

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onSaved={() => {
            setFolderSet(true);
            toast("Project folder saved.", "success");
          }}
        />
      )}
    </div>
  );
}
