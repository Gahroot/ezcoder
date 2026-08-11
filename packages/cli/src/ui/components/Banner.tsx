import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "../theme/theme.js";
import { getModel } from "../../core/model-registry.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import type { Provider } from "@prestyj/ai";

interface BannerProps {
  version: string;
  model: string;
  provider: Provider;
  cwd: string;
  taskCount?: number;
}

const LOGO_LINES = [
  " \u2588\u2580\u2580\u2580 \u2580\u2580\u2580\u2588",
  " \u2588\u2580\u2580   \u2584\u2580 ",
  " \u2588\u2584\u2584\u2584 \u2588\u2584\u2584\u2584",
];

// Ping-pong across active theme tokens so every theme gets a readable logo.
const GRADIENT_STEPS = 7;

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function lerpColor(from: string, to: string, amount: number): string {
  const [fromRed, fromGreen, fromBlue] = hexToRgb(from);
  const [toRed, toGreen, toBlue] = hexToRgb(to);
  const mix = (start: number, end: number): number => Math.round(start + (end - start) * amount);
  return `#${(
    (1 << 24) |
    (mix(fromRed, toRed) << 16) |
    (mix(fromGreen, toGreen) << 8) |
    mix(fromBlue, toBlue)
  )
    .toString(16)
    .slice(1)}`;
}

function buildGradient(from: string, to: string): string[] {
  const oneWay = Array.from({ length: GRADIENT_STEPS }, (_, index) =>
    lerpColor(from, to, index / (GRADIENT_STEPS - 1)),
  );
  return [...oneWay, ...oneWay.slice(1, -1).reverse()];
}

const GAP = "   ";
// Logo is 9 visible chars wide + GAP (3) = 12 chars before info text
const LOGO_WIDTH = 9;
const SIDE_BY_SIDE_MIN = LOGO_WIDTH + GAP.length + 62; // room for the shortcut hint row

export function Banner({ version, model, cwd, taskCount }: BannerProps) {
  const theme = useTheme();
  const { columns } = useTerminalSize();
  const modelInfo = getModel(model);
  const modelName = modelInfo?.name ?? model;

  const home = process.env.HOME ?? "";
  const displayPath = home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;

  // Static gradient — no animation needed since the banner is rendered once
  // into Ink's Static area. Animating here would waste CPU and could cause
  // visual duplicates on terminal resize.
  const shift = 0;

  // At narrow widths, stack logo above info instead of side-by-side
  if (columns < SIDE_BY_SIDE_MIN) {
    return (
      <Box flexDirection="column" marginTop={1} marginBottom={1} width={columns}>
        <GradientText text={LOGO_LINES[0]} shift={shift} />
        <GradientText text={LOGO_LINES[1]} shift={shift} />
        <GradientText text={LOGO_LINES[2]} shift={shift} />
        <Box marginTop={1}>
          <Text color={theme.primary} bold>
            EZ Coder
          </Text>
          <Text color={theme.textDim}> v{version}</Text>
        </Box>
        <Box>
          <Text color={theme.secondary}>{modelName}</Text>
          <Text color={theme.textDim}>{"  "}</Text>
          <Text color={theme.textDim} wrap="truncate">
            {displayPath}
          </Text>
        </Box>
        <ShortcutHints taskCount={taskCount} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1} width={columns}>
      <Box>
        <GradientText text={LOGO_LINES[0]} shift={shift} />
        <Text>{GAP}</Text>
        <Text color={theme.primary} bold>
          EZ Coder
        </Text>
        <Text color={theme.textDim}> v{version}</Text>
        <Text color={theme.textDim}> · By </Text>
        <Text color={theme.text} bold>
          Nolan Grout
        </Text>
      </Box>
      <Box>
        <GradientText text={LOGO_LINES[1]} shift={shift} />
        <Text>{GAP}</Text>
        <Text color={theme.secondary}>{modelName}</Text>
        <Text color={theme.textDim}>{"  "}</Text>
        <Text color={theme.textDim} wrap="truncate">
          {displayPath}
        </Text>
      </Box>
      <Box>
        <GradientText text={LOGO_LINES[2]} shift={shift} />
        <Text>{GAP}</Text>
        <ShortcutHints taskCount={taskCount} />
      </Box>
    </Box>
  );
}

function ShortcutHints({ taskCount }: { taskCount?: number }) {
  const theme = useTheme();
  const taskLabel = taskCount && taskCount > 0 ? ` tasks (${taskCount})` : " tasks";

  return (
    <Box>
      <Text color={theme.primary}>Ctrl+T</Text>
      <Text color={theme.textDim}>{taskLabel}</Text>
      <Text color={theme.textDim}> · </Text>
      <Text color={theme.primary}>Ctrl+S</Text>
      <Text color={theme.textDim}> skills</Text>
      <Text color={theme.textDim}> · </Text>
      <Text color={theme.primary}>Shift+Tab</Text>
      <Text color={theme.textDim}> toggle thinking</Text>
    </Box>
  );
}

function GradientText({ text, shift = 0 }: { text: string; shift?: number }) {
  const theme = useTheme();
  const gradient = React.useMemo(
    () => buildGradient(theme.primary, theme.secondary),
    [theme.primary, theme.secondary],
  );
  const chars: React.ReactNode[] = [];
  let colorIdx = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === " ") {
      chars.push(ch);
    } else {
      const color = gradient[(colorIdx + shift) % gradient.length];
      chars.push(
        <Text key={i} color={color}>
          {ch}
        </Text>,
      );
      colorIdx++;
    }
  }
  return <Text>{chars}</Text>;
}
