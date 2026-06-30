import { useEffect, useRef, useState } from "react";
import { AppWindow, Check, ChevronRight, Monitor } from "lucide-react";
import { theme } from "./theme";
import {
  setupWindows,
  arrangeAllWindows,
  listMonitors,
  setTargetMonitor,
  type MonitorInfo,
} from "./agent";
import { playSound } from "./sounds";

/**
 * Top-right control that tiles the app into a 2-, 4-, or 6-window grid (macOS
 * fill&arrange style). Each new window is a separate project with its own agent.
 * Windows open immediately; project selection happens per-window afterwards.
 *
 * `onArrange` fires when a multi-window layout is applied (count > 1) so the
 * caller can auto-hide the nav bar — tiled windows are tight on space, and the
 * setting is persisted, so the freshly opened windows boot hidden too.
 */
export function WindowLayoutButton({ onArrange }: { onArrange?: () => void }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showMonitors, setShowMonitors] = useState(false);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setShowMonitors(false);
      return;
    }
    // Refresh the display list each time the menu opens — monitors get
    // plugged/unplugged, and the saved choice may have changed elsewhere.
    void listMonitors().then((res) => {
      setMonitors(res.monitors);
      setSelected(res.selected);
    });
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const id = setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", onDoc);
    };
  }, [open]);

  async function chooseMonitor(name: string | null): Promise<void> {
    setSelected(name);
    await setTargetMonitor(name);
    playSound("hover");
  }

  // Only worth showing the monitor picker when more than one display exists.
  const multiMonitor = monitors.length > 1;
  const selectedLabel =
    (selected && monitors.find((m) => m.name === selected)?.label) ?? "Primary (auto)";

  async function applyLayout(count: number): Promise<void> {
    setOpen(false);
    if (busy) return;
    setBusy(true);
    try {
      if (count > 1) {
        onArrange?.();
        playSound("hover");
      }
      await setupWindows(count);
    } finally {
      setBusy(false);
    }
  }

  async function arrangeAll(): Promise<void> {
    setOpen(false);
    if (busy) return;
    setBusy(true);
    try {
      await arrangeAllWindows();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="winlayout" ref={ref}>
      <button
        className="btn btn-ghost btn-sm btn-nav-icon"
        disabled={busy}
        title="Arrange into multiple project windows"
        onClick={() => setOpen((o) => !o)}
      >
        <AppWindow size={16} />
      </button>
      {open && (
        <>
          {/* Full-screen catcher: closes the menu on any outside click. The
              document `mousedown` listener can't see clicks on Tauri
              `data-tauri-drag-region` areas (the OS swallows them for window
              dragging), so this backdrop guarantees dismissal. */}
          <div className="menu-backdrop" onMouseDown={() => setOpen(false)} />
          <div
            className="winlayout-menu"
            style={{ background: theme.surface2, borderColor: theme.border }}
          >
            <button
              className="winlayout-item"
              style={{ color: theme.text }}
              onClick={() => void applyLayout(2)}
            >
              2 windows
            </button>
            <button
              className="winlayout-item"
              style={{ color: theme.text }}
              onClick={() => void applyLayout(4)}
            >
              4 windows
            </button>
            <button
              className="winlayout-item"
              style={{ color: theme.text }}
              onClick={() => void applyLayout(6)}
            >
              6 windows
            </button>
            <div className="winlayout-divider" />
            <button
              className="winlayout-item"
              style={{ color: theme.text }}
              onClick={() => void arrangeAll()}
            >
              Auto-arrange all
            </button>
            {multiMonitor && (
              <>
                <div className="winlayout-divider" />
                <button
                  className="winlayout-item"
                  style={{ color: theme.text, justifyContent: "space-between" }}
                  onClick={() => setShowMonitors((s) => !s)}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <Monitor size={14} />
                    Display
                  </span>
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      color: theme.textDim,
                      fontSize: 11,
                    }}
                  >
                    {selectedLabel}
                    <ChevronRight
                      size={13}
                      style={{
                        transform: showMonitors ? "rotate(90deg)" : "none",
                        transition: "transform 120ms",
                      }}
                    />
                  </span>
                </button>
                {showMonitors && (
                  <>
                    <MonitorRow
                      label="Primary (auto)"
                      active={selected === null}
                      onClick={() => void chooseMonitor(null)}
                    />
                    {monitors.map((m) => (
                      <MonitorRow
                        key={m.name}
                        label={`${m.label} \u00b7 ${m.width}\u00d7${m.height}`}
                        active={selected === m.name}
                        onClick={() => void chooseMonitor(m.name)}
                      />
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** One selectable display in the monitor submenu; shows a check when active. */
function MonitorRow({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      className="winlayout-item"
      style={{ color: active ? theme.text : theme.textDim, paddingLeft: 22, fontSize: 12 }}
      onClick={onClick}
    >
      <Check size={13} style={{ opacity: active ? 1 : 0, flexShrink: 0 }} />
      {label}
    </button>
  );
}
