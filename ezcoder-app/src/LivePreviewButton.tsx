import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LivePreviewPanel } from "./LivePreviewPanel";
import type { LivePreview } from "./useLivePreview";
import { theme } from "./theme";

/** Header button for the live preview; opens its panel below, like the window-layout menu. */
export function LivePreviewButton({
  preview,
  onStartDevServer,
}: {
  preview: LivePreview;
  onStartDevServer: () => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const panelId = useId();
  const running = preview.status?.running ?? false;

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
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
      if (rect) setPosition({ top: rect.bottom + 8, right: window.innerWidth - rect.right });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  return (
    <div className="winlayout" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-sm btn-ghost livepreview-trigger"
        title="Open your running app in the browser, with EZ Coder's chat on it"
        aria-label={running ? "Live preview, running" : "Live preview"}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => {
          const next = !open;
          setOpen(next);
          // Opening finds (or reuses) the dev server straight away, like upstream's key.
          if (next && !running && !preview.busy) void preview.start();
        }}
      >
        Preview
        <span className="livepreview-led" data-state={running ? "on" : undefined} aria-hidden />
      </button>
      {open &&
        createPortal(
          <>
            <div className="menu-backdrop" onMouseDown={() => setOpen(false)} />
            <div
              ref={panelRef}
              id={panelId}
              className="winlayout-menu livepreview-menu"
              role="dialog"
              aria-label="Live preview"
              style={{
                background: theme.surface2,
                borderColor: theme.border,
                top: position?.top ?? 0,
                right: position?.right ?? 0,
                visibility: position ? "visible" : "hidden",
              }}
            >
              <LivePreviewPanel
                preview={preview}
                onStartDevServer={() => {
                  onStartDevServer();
                  setOpen(false);
                }}
              />
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
