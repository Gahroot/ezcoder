import React from "react";
import { Text, Box } from "ink";
import { useTheme } from "../theme/theme.js";
import type { PasteInfo } from "./InputArea.js";
import { getUserMessageDisplayParts } from "../utils/user-message-display.js";

export function UserMessage({
  text,
  imageCount,
  pasteInfo,
}: {
  text: string;
  imageCount?: number;
  pasteInfo?: PasteInfo;
}) {
  const theme = useTheme();

  const parts = getUserMessageDisplayParts(text, pasteInfo);

  return (
    <Box marginTop={1} flexDirection="column">
      <Box>
        <Text wrap="wrap" color="white" backgroundColor="gray">
          <Text color={theme.inputPrompt} backgroundColor="gray">
            {"❯ "}
          </Text>
          {parts.map((part, index) => (
            <React.Fragment key={index}>
              {index > 0 ? <Text backgroundColor="gray"> </Text> : null}
              <Text dimColor={part.kind === "paste"} backgroundColor="gray">
                {part.text}
              </Text>
            </React.Fragment>
          ))}
          {imageCount != null &&
            imageCount > 0 &&
            Array.from({ length: imageCount }, (_, i) => (
              <Text key={i} color={theme.accent} backgroundColor="gray">
                {" "}
                [Image #{i + 1}]
              </Text>
            ))}
        </Text>
      </Box>
    </Box>
  );
}
