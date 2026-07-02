// "NOLAN ON" / "NOLAN OFF" ASCII banner shown over the chat BODY (inside
// `.transcript-frame`, a non-scrolling sibling of `.transcript` sized to the
// same viewport — NOT inside `.transcript` itself, which scrolls, so an
// absolutely positioned overlay there would pin to the scrolled content
// instead of what's on screen) when Autopilot (Nolan's auto-review loop) is
// toggled — the chat head/nav and footer stay visible around it. Same
// ANSI-Shadow block font as the home-screen EZ CODER logo (see AsciiLogo.tsx),
// tinted in Nolan's teal. Pops in with the same scale+fade "flash" the app uses
// for its zoom-level HUD, holds briefly, then dissolves back out — quick,
// decorative, non-interactive, no lateral motion. Self-removes via `onDone`
// once the animation finishes so the caller can just stop rendering it.
const NOLAN_ON = [
  "███╗   ██╗ ██████╗ ██╗      █████╗ ███╗   ██╗     ██████╗ ███╗   ██╗",
  "████╗  ██║██╔═══██╗██║     ██╔══██╗████╗  ██║    ██╔═══██╗████╗  ██║",
  "██╔██╗ ██║██║   ██║██║     ███████║██╔██╗ ██║    ██║   ██║██╔██╗ ██║",
  "██║╚██╗██║██║   ██║██║     ██╔══██║██║╚██╗██║    ██║   ██║██║╚██╗██║",
  "██║ ╚████║╚██████╔╝███████╗██║  ██║██║ ╚████║    ╚██████╔╝██║ ╚████║",
  "╚═╝  ╚═══╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝     ╚═════╝ ╚═╝  ╚═══╝",
];

const NOLAN_OFF = [
  "███╗   ██╗ ██████╗ ██╗      █████╗ ███╗   ██╗     ██████╗ ███████╗███████╗",
  "████╗  ██║██╔═══██╗██║     ██╔══██╗████╗  ██║    ██╔═══██╗██╔════╝██╔════╝",
  "██╔██╗ ██║██║   ██║██║     ███████║██╔██╗ ██║    ██║   ██║█████╗  █████╗  ",
  "██║╚██╗██║██║   ██║██║     ██╔══██║██║╚██╗██║    ██║   ██║██╔══╝  ██╔══╝  ",
  "██║ ╚████║╚██████╔╝███████╗██║  ██║██║ ╚████║    ╚██████╔╝██║     ██║     ",
  "╚═╝  ╚═══╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝     ╚═════╝ ╚═╝     ╚═╝     ",
];

interface Props {
  mode: "on" | "off";
  /** Fired once the slide-out animation finishes — unmount it here. */
  onDone: () => void;
}

export function NolanPowerBanner({ mode, onDone }: Props): React.ReactElement {
  const lines = mode === "on" ? NOLAN_ON : NOLAN_OFF;
  return (
    <div className="nolan-power-overlay" aria-hidden="true">
      {/* Keyed on `mode` so flipping the toggle again mid-animation remounts
          this node instead of restyling it in place — the slide-in/out
          animation always plays from a clean start, even on a rapid
          on/off/on flip. */}
      <div
        key={mode}
        className={`nolan-power-banner nolan-power-banner-${mode}`}
        onAnimationEnd={onDone}
      >
        {lines.map((line, i) => (
          <div className="nolan-power-banner-line" key={i}>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}
