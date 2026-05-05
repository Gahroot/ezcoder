import React, { useEffect, useState } from "react";
import { Box, Text, render } from "ink";
import { AUTHOR, BRAND, COLORS, GRADIENT, VERSION } from "./branding.js";

/**
 * Big ASCII "GG Boss" rendered for the splash. The block characters here are
 * ANSI Shadow-style figlet output. Whitespace is significant — every line is
 * the same width so the gradient striping aligns vertically. Do not reformat.
 */
const SPLASH_LINES: readonly string[] = [
  "   █████████    █████████     ███████████                          ",
  "  ███░░░░░███  ███░░░░░███   ░░███░░░░░███                         ",
  " ███     ░░░  ███     ░░░     ░███    ░███  ██████   █████   █████ ",
  "░███         ░███             ░██████████  ███░░███ ███░░   ███░░  ",
  "░███    █████░███    █████    ░███░░░░░███░███ ░███░░█████ ░░█████ ",
  "░░███  ░░███ ░░███  ░░███     ░███    ░███░███ ░███ ░░░░███ ░░░░███",
  " ░░█████████  ░░█████████     ███████████ ░░██████  ██████  ██████ ",
  "  ░░░░░░░░░    ░░░░░░░░░     ░░░░░░░░░░░   ░░░░░░  ░░░░░░  ░░░░░░  ",
];

const SPLASH_WIDTH = SPLASH_LINES[0]!.length;

/**
 * Vertical gradient stripe — assigns each line a colour from the brand
 * gradient so the logo gets a soft top→bottom hue transition. Filled glyphs
 * (`█`) take the line's hue at full brightness; shadow glyphs (`░`) inherit
 * the same hue but render at lower intensity (via `dimColor`) so they read
 * as a drop-shadow rather than fighting for visual weight with the fill.
 */
function colorForLine(lineIdx: number, totalLines: number, offset: number): string {
  const t = totalLines <= 1 ? 0 : (lineIdx + offset) % totalLines;
  const idx = Math.floor((t / totalLines) * GRADIENT.length) % GRADIENT.length;
  return GRADIENT[idx]!;
}

interface SplashProps {
  /** Pulse offset — bumping this on a timer rotates the gradient through the
   *  logo for a subtle "shimmer" while the splash is mounted. */
  offset: number;
}

function SplashLogo({ offset }: SplashProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      {SPLASH_LINES.map((line, i) => {
        const hue = colorForLine(i, SPLASH_LINES.length, offset);
        // Split into runs so we can dim the shadow glyphs (░) without breaking
        // the line into one Text per char (which Ink would happily handle but
        // is wasteful at this scale).
        const segments: { text: string; dim: boolean }[] = [];
        let buf = "";
        let bufDim = false;
        for (const ch of line) {
          const dim = ch === "░";
          if (segments.length === 0 && buf.length === 0) {
            buf = ch;
            bufDim = dim;
            continue;
          }
          if (dim === bufDim) {
            buf += ch;
          } else {
            segments.push({ text: buf, dim: bufDim });
            buf = ch;
            bufDim = dim;
          }
        }
        if (buf) segments.push({ text: buf, dim: bufDim });

        return (
          <Text key={i}>
            {segments.map((seg, j) => (
              <Text key={j} color={hue} dimColor={seg.dim}>
                {seg.text}
              </Text>
            ))}
          </Text>
        );
      })}
    </Box>
  );
}

interface SplashScreenProps {
  /** Optional caption shown under the logo — defaults to a "Loading…" line. */
  caption?: string;
}

export function SplashScreen({ caption }: SplashScreenProps): React.ReactElement {
  const [offset, setOffset] = useState(0);
  // Soft shimmer — rotates the gradient through the logo every 120ms. Stops
  // when the component unmounts (the cli swaps the splash out as soon as the
  // boss has finished initialising).
  useEffect(() => {
    const timer = setInterval(() => {
      setOffset((o) => o + 1);
    }, 120);
    return () => {
      clearInterval(timer);
    };
  }, []);

  return (
    <Box flexDirection="column" alignItems="flex-start" paddingTop={1} paddingLeft={2}>
      <SplashLogo offset={offset} />
      <Box width={SPLASH_WIDTH} marginTop={1}>
        <Text color={COLORS.text} bold>
          {BRAND}
        </Text>
        <Text color={COLORS.textDim}> v{VERSION}</Text>
        <Text color={COLORS.textDim}> · By </Text>
        <Text color={COLORS.text} bold>
          {AUTHOR}
        </Text>
      </Box>
      <Box width={SPLASH_WIDTH}>
        <Text color={COLORS.textDim}>{caption ?? "Spinning up the orchestrator…"}</Text>
      </Box>
    </Box>
  );
}

/**
 * Render the splash to stdout. Returns a `dismiss()` that holds the splash
 * for at least `minMs` total visible time (so even fast inits get a real
 * flash of branding) before unmounting, and resolves only after the unmount
 * has actually completed — so the caller can safely render the main app
 * next without two Ink trees coexisting on screen.
 */
export function showSplash(opts: {
  minMs?: number;
  caption?: string;
}): { dismiss: () => Promise<void> } {
  const start = Date.now();
  const instance = render(<SplashScreen caption={opts.caption} />);
  return {
    dismiss: async () => {
      const minMs = opts.minMs ?? 900;
      const elapsed = Date.now() - start;
      const remaining = Math.max(0, minMs - elapsed);
      if (remaining > 0) {
        await new Promise((r) => setTimeout(r, remaining));
      }
      instance.unmount();
      // Give Ink one tick to flush the unmount writes before the caller
      // starts mounting the next tree.
      await new Promise((r) => setImmediate(r));
    },
  };
}
