// Centered "EZ CODER" ASCII banner with a horizontal gradient + animated
// shimmer sweep. Mirrors the brand gradient used across the CLI logos.
const LOGO_LINES = [
  "███████╗███████╗     ██████╗ ██████╗ ██████╗ ███████╗██████╗ ",
  "██╔════╝╚══███╔╝    ██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔══██╗",
  "█████╗    ███╔╝     ██║     ██║   ██║██║  ██║█████╗  ██████╔╝",
  "██╔══╝   ███╔╝      ██║     ██║   ██║██║  ██║██╔══╝  ██╔══██╗",
  "███████╗███████╗    ╚██████╗╚██████╔╝██████╔╝███████╗██║  ██║",
  "╚══════╝╚══════╝     ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝",
];

const LOGO_TEXT = LOGO_LINES.join("\n");

export function AsciiLogo(): React.ReactElement {
  return (
    <div className="ascii-logo" role="img" aria-label="EZ Coder">
      <div className="ascii-logo-glitch" data-text={LOGO_TEXT} aria-hidden="true">
        {LOGO_LINES.map((line, i) => (
          <div className="ascii-logo-line" key={i}>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}
