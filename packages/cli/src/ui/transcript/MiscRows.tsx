import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "../theme/theme.js";
import type {
  DurationItem,
  ErrorItem,
  GoalProgressItem,
  QueuedItem,
  SetupHintItem,
  StepDoneItem,
  StylePackItem,
  UpdateNoticeItem,
} from "../app-items.js";
import {
  presentDuration,
  presentError,
  presentQueued,
  presentSetupHint,
  presentStepDone,
  presentStylePack,
  presentUpdateNotice,
} from "./presentation.js";

export function StylePackRow({ item }: { item: StylePackItem }) {
  const theme = useTheme();
  const presentation = presentStylePack(item);

  return (
    <Box key={item.id} paddingLeft={1} flexShrink={1}>
      <Box
        flexShrink={1}
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.language}
        paddingX={1}
      >
        <Text wrap="wrap">
          <Text color={theme.language} bold>
            {"◆ "}
          </Text>
          <Text color={theme.language} bold>
            {presentation.headerLabel}
          </Text>
        </Text>
        <Text color={theme.text} bold wrap="wrap">
          {presentation.names}
        </Text>
        {presentation.showSetupHint && (
          <Box marginTop={1}>
            <Text wrap="wrap">
              <Text color={theme.textMuted}>{"Tip: run "}</Text>
              <Text color={theme.language} bold>
                {"/setup"}
              </Text>
              <Text color={theme.textMuted}>{presentation.setupHint}</Text>
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

export function SetupHintRow({ item }: { item: SetupHintItem }) {
  const theme = useTheme();
  const presentation = presentSetupHint(item);

  return (
    <Box key={item.id} paddingLeft={1} flexShrink={1}>
      <Box
        flexShrink={1}
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.language}
        paddingX={1}
      >
        <Text wrap="wrap">
          <Text color={theme.language} bold>
            {"◆ "}
          </Text>
          <Text color={theme.language} bold>
            {presentation.headerLabel}
          </Text>
        </Text>
        <Text color={theme.textMuted} wrap="wrap">
          {presentation.body}
        </Text>
        <Box marginTop={1}>
          <Text wrap="wrap">
            <Text color={theme.textMuted}>{"Tip: run "}</Text>
            <Text color={theme.language} bold>
              {"/setup"}
            </Text>
            <Text color={theme.textMuted}>{presentation.setupHint}</Text>
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

export function ErrorRow({ item }: { item: ErrorItem }) {
  const theme = useTheme();
  const presentation = presentError(item);

  return (
    <Box key={item.id} flexDirection="row" paddingLeft={1} flexShrink={1}>
      <Box width={2} flexShrink={0}>
        <Text color={theme.error} bold>
          {presentation.glyph}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <Text color={theme.error} wrap="wrap">
          {presentation.headline}
        </Text>
        {presentation.message && (
          <Text color={theme.textDim} wrap="wrap">
            {presentation.message}
          </Text>
        )}
        <Text color={theme.textDim} wrap="wrap">
          {presentation.guidance}
        </Text>
      </Box>
    </Box>
  );
}

export function UpdateNoticeRow({ item }: { item: UpdateNoticeItem }) {
  const theme = useTheme();
  const presentation = presentUpdateNotice(item);

  return (
    <Box key={item.id} paddingLeft={1} flexShrink={1}>
      <Box flexShrink={1} borderStyle="round" borderColor={theme.commandColor} paddingX={1}>
        <Text color={theme.commandColor} bold wrap="wrap">
          {presentation.text}
        </Text>
      </Box>
    </Box>
  );
}

export function StepDoneRow({ item }: { item: StepDoneItem }) {
  const theme = useTheme();
  const presentation = presentStepDone(item);

  return (
    <Box key={item.id} paddingLeft={1} flexShrink={1}>
      <Text wrap="wrap">
        <Text color={theme.planPrimary} bold>
          {presentation.glyph}
        </Text>
        <Text color={theme.planPrimary} bold>
          {presentation.text}
        </Text>
        {presentation.description ? (
          <Text color={theme.accent}>{presentation.description}</Text>
        ) : null}
      </Text>
    </Box>
  );
}

function goalProgressColor(item: GoalProgressItem, theme: ReturnType<typeof useTheme>): string {
  if (item.status === "failed" || item.status === "fail" || item.status === "blocked") {
    return theme.error;
  }
  if (item.phase === "worker_finished" || item.phase === "terminal") return theme.success;
  if (item.phase === "verifier_started" || item.phase === "verifier_finished") return theme.accent;
  if (item.phase === "orchestrator_reviewing" || item.phase === "orchestrator_working") {
    return theme.secondary;
  }
  if (item.phase === "continuing") return theme.warning;
  return theme.primary;
}

export function GoalProgressRow({ item }: { item: GoalProgressItem }) {
  const theme = useTheme();
  const color = goalProgressColor(item, theme);
  const glyph =
    item.phase === "worker_finished" || item.phase === "verifier_finished"
      ? "✓ "
      : item.phase === "terminal"
        ? item.status === "passed"
          ? "◆ "
          : "! "
        : "↻ ";
  return (
    <Box flexDirection="column" flexShrink={1}>
      <Text wrap="wrap">
        <Text color={color} bold>
          {glyph}
          {item.title}
        </Text>
        {item.workerId ? <Text color={theme.textDim}> · worker {item.workerId}</Text> : null}
      </Text>
      {item.detail ? (
        <Text color={theme.textDim} wrap="wrap">
          {`  ${item.detail}`}
        </Text>
      ) : null}
      {item.summaryRows && item.summaryRows.length > 0 ? (
        <Box flexDirection="column" marginTop={1} marginLeft={2} flexShrink={1}>
          {item.summaryRows.map((row) => (
            <Text key={row.label} wrap="truncate">
              <Text color={theme.textDim}>{row.label.padEnd(10)}</Text>
              <Text color={theme.text}>{row.value}</Text>
              {row.detail ? <Text color={theme.textDim}> · {row.detail}</Text> : null}
            </Text>
          ))}
        </Box>
      ) : null}
      {item.summarySections && item.summarySections.length > 0 ? (
        <Box flexDirection="column" marginTop={1} marginLeft={2} flexShrink={1}>
          {item.summarySections.map((section) => (
            <Box key={section.title} flexDirection="column" marginBottom={1} flexShrink={1}>
              <Text color={theme.textDim} bold>
                {section.title}
              </Text>
              {section.lines.map((line, index) => (
                <Text key={`${section.title}-${index}`} color={theme.text} wrap="wrap">
                  {`• ${line}`}
                </Text>
              ))}
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

export function QueuedRow({ item }: { item: QueuedItem }) {
  const theme = useTheme();
  const presentation = presentQueued(item);

  return (
    <Box key={item.id} flexDirection="row" paddingLeft={1} flexShrink={1}>
      <Box width={2} flexShrink={0}>
        <Text color={theme.warning} bold>
          {presentation.glyph}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <Text color={theme.text} wrap="wrap">
          <Text color={theme.textDim}>{presentation.label}</Text>
          {presentation.text}
          {presentation.suffix}
        </Text>
      </Box>
    </Box>
  );
}

export function DurationRow({ item }: { item: DurationItem }) {
  const theme = useTheme();
  const presentation = presentDuration(item);

  return (
    <Box key={item.id} paddingLeft={1}>
      <Text color={theme.textDim}>
        {presentation.glyph}
        {presentation.text}
      </Text>
    </Box>
  );
}
