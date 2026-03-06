import React from "react";
import { Text, Box } from "ink";
import { useTheme } from "../theme/theme.js";

export function UserMessage({ text, imageCount }: { text: string; imageCount?: number }) {
  const theme = useTheme();

  return (
    <Box marginTop={1} flexWrap="wrap">
      <Text color={theme.inputPrompt}>{"❯ "}</Text>
      <Box flexShrink={1}>
        <Text color={theme.textMuted}>{text}</Text>
      </Box>
      {imageCount != null &&
        imageCount > 0 &&
        Array.from({ length: imageCount }, (_, i) => (
          <Text key={i} color={theme.accent}>
            {" "}
            [Image #{i + 1}]
          </Text>
        ))}
    </Box>
  );
}
