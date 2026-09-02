import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AppWindow, Check, ChevronRight, Monitor } from "lucide-react";
import {
  setupWindows,
  arrangeAllWindows,
  listMonitors,
  setTargetMonitor,
  type MonitorInfo,
} from "./agent";
import { playSound } from "./sounds";
import { theme } from "./theme";

/**
 * Titlebar control that tiles the app into a 2-, 4-, or 6-window grid,
 * auto-arranges all open windows, and targets a selected display.
 */
export function WindowLayoutButton({ onArrange }: { onArrange?: () => void }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showMonitors, setShowMonitors] = useState(false);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; right: number } | null>(null);
  const menuId = useId();

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
    const closeOnOutsideClick = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const listenerId = window.setTimeout(
      () => document.addEventListener("mousedown", closeOnOutsideClick),
      0,
    );
    document.addEventListener("keydown", closeOnEscape);
    requestAnimationFrame(() =>
      menuRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus(),
    );
    return () => {
      window.clearTimeout(listenerId);
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) setMenuPosition({ top: rect.bottom + 8, right: window.innerWidth - rect.right });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  async function chooseMonitor(name: string | null): Promise<void> {
    setSelected(name);
    await setTargetMonitor(name);
    playSound("hover");
  }

  // Only worth showing the monitor picker when more than one display exists.
  const multiMonitor = monitors.length > 1;
  const selectedLabel =
    (selected && monitors.find((monitor) => monitor.name === selected)?.label) ?? "Primary (auto)";

  async function run(choice: string): Promise<void> {
    if (busy) return;
    setOpen(false);
    setBusy(true);
    try {
      if (choice === "auto") {
        await arrangeAllWindows();
      } else {
        const count = Number(choice);
        if (count > 1) {
          onArrange?.();
          playSound("hover");
        }
        await setupWindows(count);
      }
    } finally {
      setBusy(false);
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }

  function moveMenuFocus(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[role='menuitem']"),
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }

  return (
    <div className="winlayout" ref={rootRef}>
      <button
        ref={triggerRef}
        className="btn btn-ghost btn-sm btn-nav-icon"
        disabled={busy}
        title="Arrange into multiple project windows"
        aria-label="Arrange into multiple project windows"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <AppWindow size={16} />
      </button>
      {open &&
        createPortal(
          <>
            <div className="menu-backdrop" onMouseDown={() => setOpen(false)} />
            <div
              ref={menuRef}
              id={menuId}
              className="winlayout-menu"
              role="menu"
              aria-label="Window layout"
              onKeyDown={moveMenuFocus}
              style={{
                background: theme.surface2,
                borderColor: theme.border,
                top: menuPosition?.top ?? 0,
                right: menuPosition?.right ?? 0,
                visibility: menuPosition ? "visible" : "hidden",
              }}
            >
              <button role="menuitem" className="winlayout-item" onClick={() => void run("2")}>
                2 windows
              </button>
              <button role="menuitem" className="winlayout-item" onClick={() => void run("4")}>
                4 windows
              </button>
              <button role="menuitem" className="winlayout-item" onClick={() => void run("6")}>
                6 windows
              </button>
              <div className="winlayout-divider" role="separator" />
              <button role="menuitem" className="winlayout-item" onClick={() => void run("auto")}>
                Auto-arrange all
              </button>
              {multiMonitor && (
                <>
                  <div className="winlayout-divider" role="separator" />
                  <button
                    role="menuitem"
                    className="winlayout-item"
                    style={{ color: theme.text, justifyContent: "space-between" }}
                    onClick={() => setShowMonitors((shown) => !shown)}
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
                      {monitors.map((monitor) => (
                        <MonitorRow
                          key={monitor.name}
                          label={`${monitor.label} \u00b7 ${monitor.width}\u00d7${monitor.height}`}
                          active={selected === monitor.name}
                          onClick={() => void chooseMonitor(monitor.name)}
                        />
                      ))}
                    </>
                  )}
                </>
              )}
            </div>
          </>,
          document.body,
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
      role="menuitem"
      className="winlayout-item"
      style={{ color: active ? theme.text : theme.textDim, paddingLeft: 22, fontSize: 12 }}
      onClick={onClick}
    >
      <Check size={13} style={{ opacity: active ? 1 : 0, flexShrink: 0 }} />
      {label}
    </button>
  );
}
