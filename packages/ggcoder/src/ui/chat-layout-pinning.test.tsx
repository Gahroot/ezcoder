import React from "react";
import { Box, Text, render } from "ink";
import { describe, expect, it } from "vitest";
import {
  getChatControlsLayoutDecision,
  partitionCompleted,
  pinStreamingTextBeforeToolBoundary,
  shouldTopSpaceAssistantAfterToolBoundary,
  shouldTopSpaceStreamingAssistant,
} from "./App.js";
import type { FooterStatusLayoutDecision } from "./components/BackgroundTasksBar.js";

function stripAnsi(value: string): string {
  return value.replace(new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, "g"), "");
}

function getLastFrameLines(output: string): string[] {
  const text = stripAnsi(output);
  const lastFooterIndex = text.lastIndexOf("FOOTER");
  if (lastFooterIndex === -1) return [];
  const previousFooterIndex = text.lastIndexOf("FOOTER", lastFooterIndex - 1);
  const start = previousFooterIndex === -1 ? 0 : previousFooterIndex + "FOOTER".length;
  return text
    .slice(start, lastFooterIndex + "FOOTER".length)
    .split("\n")
    .filter(Boolean);
}

function CompactChatHarness({ liveCount }: { liveCount: number }) {
  return (
    <Box flexDirection="column" width={40}>
      <Box flexDirection="column" paddingRight={1}>
        {Array.from({ length: liveCount }, (_, index) => (
          <Text key={index}>LIVE_ROW_{String(index + 1).padStart(2, "0")}</Text>
        ))}
      </Box>
      <Box flexDirection="column">
        <Text>CONTROL_STATUS</Text>
        <Text>CHAT_INPUT</Text>
        <Text>FOOTER</Text>
      </Box>
    </Box>
  );
}

function PinnedChatHarness({ liveCount }: { liveCount: number }) {
  const rows = 8;
  const controlsRows = 3;
  const liveAreaRows = rows - controlsRows;
  const shouldPin = liveCount > 0;
  return (
    <Box flexDirection="column" width={40} height={shouldPin ? rows : undefined}>
      <Box
        flexDirection="column"
        height={shouldPin ? liveAreaRows : undefined}
        maxHeight={liveAreaRows}
        justifyContent={shouldPin ? "flex-end" : undefined}
        overflowY={shouldPin ? "hidden" : undefined}
      >
        {Array.from({ length: liveCount }, (_, index) => (
          <Text key={index}>LIVE_ROW_{String(index + 1).padStart(2, "0")}</Text>
        ))}
      </Box>
      <Box flexDirection="column" minHeight={controlsRows}>
        <Text>CONTROL_STATUS</Text>
        <Text>CHAT_INPUT</Text>
        <Text>FOOTER</Text>
      </Box>
    </Box>
  );
}

const noFooterStatus: FooterStatusLayoutDecision = {
  hasBackgroundTasks: false,
  hasUpdateNotice: false,
  stack: false,
  compactBackgroundTasks: false,
};

describe("streaming assistant ordering", () => {
  it("pins visible streaming assistant text before the first tool row", () => {
    const items = pinStreamingTextBeforeToolBoundary({
      items: [],
      visibleStreamingText: "I’ll inspect the renderer first.",
      thinking: "",
      thinkingMs: 0,
      makeId: () => "assistant-pinned-1",
    });

    expect(items).toEqual([
      {
        kind: "assistant",
        text: "I’ll inspect the renderer first.",
        thinking: undefined,
        thinkingMs: undefined,
        id: "assistant-pinned-1",
      },
    ]);
  });

  it("does not pin duplicate assistant text when a live assistant row already exists", () => {
    const existing = {
      kind: "assistant" as const,
      text: "I’ll inspect the renderer first.",
      id: "assistant-existing-1",
    };

    expect(
      pinStreamingTextBeforeToolBoundary({
        items: [existing],
        visibleStreamingText: "I’ll inspect the renderer first.",
        thinking: "",
        thinkingMs: 0,
        makeId: () => "assistant-pinned-1",
      }),
    ).toEqual([existing]);
  });

  it("keeps pinned assistant text in front of a subsequently appended tool row", () => {
    const pinned = pinStreamingTextBeforeToolBoundary({
      items: [],
      visibleStreamingText: "I’ll inspect the renderer first.",
      thinking: "",
      thinkingMs: 0,
      makeId: () => "assistant-pinned-1",
    });

    const next = [
      ...pinned,
      {
        kind: "tool_start" as const,
        toolCallId: "read-1",
        name: "read",
        args: { file_path: "src/ui/App.tsx" },
        id: "tool-1",
        startedAt: 0,
        animateUntil: 0,
      },
    ];

    expect(next.map((item) => item.kind)).toEqual(["assistant", "tool_start"]);
  });

  it("flushes pinned assistant text with the completed tool row that follows it", () => {
    const assistant = {
      kind: "assistant" as const,
      text: "I’ll inspect these files first.",
      id: "assistant-pinned-1",
    };
    const group = {
      kind: "tool_group" as const,
      id: "tool-group-1",
      tools: [
        {
          toolCallId: "read-1",
          name: "read",
          args: { file_path: "src/a.ts" },
          status: "done" as const,
          result: "ok",
        },
      ],
    };

    const { flushed, remaining } = partitionCompleted([assistant, group]);

    expect(flushed.map((item) => item.kind)).toEqual(["assistant", "tool_group"]);
    expect(remaining).toEqual([]);
  });
});

describe("streaming assistant spacing", () => {
  it("top-spaces streaming text after the last flushed tool row", () => {
    expect(
      shouldTopSpaceStreamingAssistant({
        visibleStreamingText: "Next I’ll inspect the terminal history serialized output.",
        lastHistoryItem: {
          kind: "tool_group",
          id: "tool-group-1",
          tools: [],
        },
      }),
    ).toBe(true);
  });

  it("top-spaces streaming text while the flushed tool row is still pending history commit", () => {
    expect(
      shouldTopSpaceStreamingAssistant({
        visibleStreamingText: "Next I’ll inspect the terminal history serialized output.",
        lastPendingHistoryItem: {
          kind: "tool_group",
          id: "tool-group-1",
          tools: [],
        },
      }),
    ).toBe(true);
  });

  it("top-spaces a completed live assistant row after a flushed tool boundary", () => {
    expect(
      shouldTopSpaceAssistantAfterToolBoundary({
        text: "Next I’ll inspect the terminal history serialized output.",
        lastPendingHistoryItem: {
          kind: "tool_group",
          id: "tool-group-1",
          tools: [],
        },
      }),
    ).toBe(true);
  });

  it("does not top-space streaming text when no prior agent row exists", () => {
    expect(
      shouldTopSpaceStreamingAssistant({
        visibleStreamingText: "First answer in the conversation.",
      }),
    ).toBe(false);
  });
});

describe("chat controls layout", () => {
  it("reserves stable controls rows while the agent is running", () => {
    const layout = getChatControlsLayoutDecision({
      rows: 24,
      columns: 80,
      agentRunning: true,
      activityVisible: true,
      doneStatusVisible: false,
      stallStatusVisible: false,
      exitPending: false,
      footerStatusLayout: noFooterStatus,
      taskBarExpanded: false,
      goalStatusEntryCount: 0,
      footerFitsOnOneLine: true,
    });

    expect(layout).toEqual({ controlsRows: 6, liveAreaRows: 18 });
  });

  it("reserves the same controls rows for running and done status", () => {
    const running = getChatControlsLayoutDecision({
      rows: 24,
      columns: 80,
      agentRunning: true,
      activityVisible: true,
      doneStatusVisible: false,
      stallStatusVisible: false,
      exitPending: false,
      footerStatusLayout: noFooterStatus,
      taskBarExpanded: false,
      goalStatusEntryCount: 0,
      footerFitsOnOneLine: true,
    });
    const done = getChatControlsLayoutDecision({
      rows: 24,
      columns: 80,
      agentRunning: false,
      activityVisible: false,
      doneStatusVisible: true,
      stallStatusVisible: false,
      exitPending: false,
      footerStatusLayout: noFooterStatus,
      taskBarExpanded: false,
      goalStatusEntryCount: 0,
      footerFitsOnOneLine: true,
    });

    expect(done.controlsRows).toBe(running.controlsRows);
  });

  it("keeps a minimum live area when controls consume most terminal rows", () => {
    const layout = getChatControlsLayoutDecision({
      rows: 10,
      columns: 80,
      agentRunning: true,
      activityVisible: true,
      doneStatusVisible: false,
      stallStatusVisible: false,
      exitPending: false,
      footerStatusLayout: {
        ...noFooterStatus,
        hasBackgroundTasks: true,
        hasUpdateNotice: true,
        stack: true,
      },
      taskBarExpanded: true,
      goalStatusEntryCount: 1,
      footerFitsOnOneLine: false,
    });

    expect(layout.liveAreaRows).toBe(3);
  });
});

describe("compact chat layout", () => {
  it("does not reserve blank terminal rows above the controls when live output is empty", () => {
    let output = "";
    const stdout = {
      columns: 40,
      rows: 12,
      write(chunk: string) {
        output += chunk;
        return true;
      },
      on() {},
      off() {},
    } as unknown as NodeJS.WriteStream;

    const { unmount } = render(<CompactChatHarness liveCount={0} />, {
      stdout,
      columns: 40,
      rows: 12,
      debug: true,
    });

    expect(getLastFrameLines(output)).toEqual(["CONTROL_STATUS", "CHAT_INPUT", "FOOTER"]);
    unmount();
  });

  it("renders live output directly above the controls without flex filler", () => {
    let output = "";
    const stdout = {
      columns: 40,
      rows: 12,
      write(chunk: string) {
        output += chunk;
        return true;
      },
      on() {},
      off() {},
    } as unknown as NodeJS.WriteStream;

    const { unmount } = render(<CompactChatHarness liveCount={2} />, {
      stdout,
      columns: 40,
      rows: 12,
      debug: true,
    });

    expect(getLastFrameLines(output)).toEqual([
      "LIVE_ROW_01",
      "LIVE_ROW_02",
      "CONTROL_STATUS",
      "CHAT_INPUT",
      "FOOTER",
    ]);
    unmount();
  });

  it("removes fullscreen filler after live output shrinks", () => {
    let output = "";
    const stdout = {
      columns: 40,
      rows: 8,
      write(chunk: string) {
        output += chunk;
        return true;
      },
      on() {},
      off() {},
    } as unknown as NodeJS.WriteStream;

    const { rerender, unmount } = render(<PinnedChatHarness liveCount={5} />, {
      stdout,
      columns: 40,
      rows: 8,
      debug: true,
    });

    rerender(<PinnedChatHarness liveCount={0} />);

    expect(getLastFrameLines(output)).toEqual(["CONTROL_STATUS", "CHAT_INPUT", "FOOTER"]);
    unmount();
  });
});
