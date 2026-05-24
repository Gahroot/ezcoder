import React, { useMemo } from "react";
import { Text, Box, useStdout } from "ink";
import chalk from "chalk";
import { common, createLowlight } from "lowlight";
import type { Root, Element, Text as HastText, ElementContent, RootContent } from "hast";
import stripAnsi from "strip-ansi";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { useTheme } from "../theme/theme.js";
import type { Theme } from "../theme/theme.js";
import { convertLatexToUnicode } from "../utils/latex-to-unicode.js";
import { stripUnsafeCharacters } from "../utils/text-utils.js";

interface MarkdownProps {
  children: string;
  width?: number;
  compact?: boolean;
  renderMarkdown?: boolean;
  isPending?: boolean;
  availableTerminalHeight?: number;
}

const EMPTY_LINE_HEIGHT = 1;
const CODE_BLOCK_PREFIX_PADDING = 1;
const LIST_ITEM_PREFIX_PADDING = 1;
const LIST_ITEM_TEXT_FLEX_GROW = 1;
const COLUMN_PADDING = 2;
const TABLE_MARGIN = 2;
const MIN_COLUMN_WIDTH = 5;
const lowlight = createLowlight(common);

const MASK_SENTINEL = "\uE000";
const MASK_PATTERN = /\uE000(\d+)\uE000/g;

function colorize(text: string, color: string | undefined): string {
  return color ? chalk.hex(color)(text) : text;
}

function convertLatexPreservingSpans(text: string): string {
  const preserved: string[] = [];
  const masked = text.replace(/(`+)([^`\n]+?)\1|https?:\/\/\S+/g, (match) => {
    const index = preserved.push(match) - 1;
    return `${MASK_SENTINEL}${index}${MASK_SENTINEL}`;
  });
  const converted = convertLatexToUnicode(masked);
  return converted.replace(
    MASK_PATTERN,
    (match, index: string) => preserved[Number(index)] ?? match,
  );
}

function parseMarkdownToAnsi(rawText: string, theme: Theme, defaultColor?: string): string {
  const baseColor = defaultColor ?? theme.text;
  const text = convertLatexPreservingSpans(rawText);
  if (!/[*_~`<[]|https?:\/\//.test(text)) {
    return colorize(text, baseColor);
  }

  const inlineRegex =
    /(\*\*\*.*?\*\*\*|\*\*.*?\*\*|\*.*?\*|_.*?_|~~.*?~~|\[.*?\]\(.*?\)|`+.+?`+|<u>.*?<\/u>|https?:\/\/\S+)/g;
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = inlineRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result += colorize(text.slice(lastIndex, match.index), baseColor);
    }

    const fullMatch = match[0];
    let styledPart = "";

    if (fullMatch.endsWith("***") && fullMatch.startsWith("***") && fullMatch.length > 6) {
      styledPart = chalk.bold(
        chalk.italic(parseMarkdownToAnsi(fullMatch.slice(3, -3), theme, baseColor)),
      );
    } else if (fullMatch.endsWith("**") && fullMatch.startsWith("**") && fullMatch.length > 4) {
      styledPart = chalk.bold(parseMarkdownToAnsi(fullMatch.slice(2, -2), theme, baseColor));
    } else if (
      fullMatch.length > 2 &&
      ((fullMatch.startsWith("*") && fullMatch.endsWith("*")) ||
        (fullMatch.startsWith("_") && fullMatch.endsWith("_"))) &&
      !/\w/.test(text.substring(match.index - 1, match.index)) &&
      !/\w/.test(text.substring(inlineRegex.lastIndex, inlineRegex.lastIndex + 1)) &&
      !/\S[./\\]/.test(text.substring(match.index - 2, match.index)) &&
      !/[./\\]\S/.test(text.substring(inlineRegex.lastIndex, inlineRegex.lastIndex + 2))
    ) {
      styledPart = chalk.italic(parseMarkdownToAnsi(fullMatch.slice(1, -1), theme, baseColor));
    } else if (fullMatch.startsWith("~~") && fullMatch.endsWith("~~") && fullMatch.length > 4) {
      styledPart = chalk.strikethrough(
        parseMarkdownToAnsi(fullMatch.slice(2, -2), theme, baseColor),
      );
    } else if (fullMatch.startsWith("`") && fullMatch.endsWith("`") && fullMatch.length > 1) {
      const codeMatch = fullMatch.match(/^(`+)(.+?)\1$/s);
      if (codeMatch?.[2]) styledPart = colorize(codeMatch[2], theme.accent);
    } else if (fullMatch.startsWith("[") && fullMatch.includes("](") && fullMatch.endsWith(")")) {
      const linkMatch = fullMatch.match(/\[(.*?)\]\((.*?)\)/);
      if (linkMatch) {
        const linkText = linkMatch[1] ?? "";
        const url = linkMatch[2] ?? "";
        styledPart = `${parseMarkdownToAnsi(linkText, theme, baseColor)}${colorize(" (", baseColor)}${colorize(url, theme.link)}${colorize(")", baseColor)}`;
      }
    } else if (fullMatch.startsWith("<u>") && fullMatch.endsWith("</u>") && fullMatch.length > 7) {
      styledPart = chalk.underline(parseMarkdownToAnsi(fullMatch.slice(3, -4), theme, baseColor));
    } else if (fullMatch.match(/^https?:\/\//)) {
      styledPart = colorize(fullMatch, theme.link);
    }

    result += styledPart || colorize(fullMatch, baseColor);
    lastIndex = inlineRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    result += colorize(text.slice(lastIndex), baseColor);
  }

  return result;
}

function renderHastNode(
  node: Root | Element | HastText | RootContent,
  theme: Theme,
  inheritedColor: string | undefined,
): React.ReactNode {
  if (node.type === "text") {
    return <Text color={inheritedColor ?? theme.text}>{node.value}</Text>;
  }

  if (node.type === "element") {
    const nodeClasses = (node.properties?.className as string[] | undefined) ?? [];
    const elementColor = nodeClasses.find((className) => getHighlightColor(className, theme));
    const colorToPassDown = elementColor ? getHighlightColor(elementColor, theme) : inheritedColor;
    return (
      <React.Fragment>
        {node.children?.map((child: ElementContent, index: number) => (
          <React.Fragment key={index}>
            {renderHastNode(child, theme, colorToPassDown)}
          </React.Fragment>
        ))}
      </React.Fragment>
    );
  }

  if (node.type === "root") {
    if (!node.children || node.children.length === 0) return null;
    return node.children.map((child: RootContent, index: number) => (
      <React.Fragment key={index}>{renderHastNode(child, theme, inheritedColor)}</React.Fragment>
    ));
  }

  return null;
}

function getHighlightColor(className: string, theme: Theme): string | undefined {
  switch (className) {
    case "hljs-keyword":
    case "hljs-selector-tag":
    case "hljs-title":
      return theme.secondary;
    case "hljs-string":
    case "hljs-attr":
    case "hljs-symbol":
      return theme.success;
    case "hljs-number":
    case "hljs-literal":
      return theme.warning;
    case "hljs-comment":
    case "hljs-quote":
      return theme.textDim;
    case "hljs-built_in":
    case "hljs-type":
    case "hljs-class":
      return theme.accent;
    case "hljs-variable":
    case "hljs-template-variable":
      return theme.primary;
    case "hljs-deletion":
      return theme.error;
    case "hljs-addition":
      return theme.success;
    default:
      return undefined;
  }
}

function highlightAndRenderLine(
  line: string,
  language: string | null,
  theme: Theme,
): React.ReactNode {
  try {
    const strippedLine = stripAnsi(line);
    const tree =
      !language || !lowlight.registered(language)
        ? lowlight.highlightAuto(strippedLine)
        : lowlight.highlight(language, strippedLine);
    const renderedNode = renderHastNode(tree, theme, undefined);
    return renderedNode !== null ? renderedNode : strippedLine;
  } catch {
    return stripAnsi(line);
  }
}

function colorizeCode({
  code,
  language,
  maxWidth,
  theme,
  hideLineNumbers = false,
}: {
  code: string;
  language?: string | null;
  maxWidth: number;
  theme: Theme;
  hideLineNumbers?: boolean;
}): React.ReactNode {
  const finalLines = code.replace(/\n$/, "").split(/\r?\n/);
  const padWidth = String(finalLines.length).length;

  return (
    <Box flexDirection="column">
      {finalLines.map((line, index) => (
        <Box key={index} minHeight={1}>
          {!hideLineNumbers && (
            <Box
              minWidth={padWidth + 1}
              flexShrink={0}
              paddingRight={1}
              alignItems="flex-start"
              justifyContent="flex-end"
            >
              <Text color={theme.textDim}>{index + 1}</Text>
            </Box>
          )}
          <Text color={theme.text} wrap="wrap">
            {highlightAndRenderLine(line.slice(0, Math.max(0, maxWidth)), language ?? null, theme)}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function visualWidth(text: string): number {
  return stringWidth(stripAnsi(text));
}

function wrapAnsiLines(text: string, width: number): string[] {
  return wrapAnsi(text || " ", Math.max(1, width), { hard: true, wordWrap: true }).split("\n");
}

function padRightAnsi(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visualWidth(text)));
}

function RenderTable({
  headers,
  rows,
  terminalWidth,
  theme,
}: {
  headers: string[];
  rows: string[][];
  terminalWidth: number;
  theme: Theme;
}): React.ReactElement {
  const { wrappedHeaders, wrappedRows, adjustedWidths } = useMemo(() => {
    const styledHeaders = headers.map((header) =>
      parseMarkdownToAnsi(stripUnsafeCharacters(header), theme, theme.link),
    );
    const styledRows = rows.map((row) =>
      row.map((cell) => parseMarkdownToAnsi(stripUnsafeCharacters(cell), theme, theme.text)),
    );
    const numColumns = Math.max(styledHeaders.length, ...styledRows.map((row) => row.length), 1);

    const constraints = Array.from({ length: numColumns }).map((_, colIndex) => {
      const values = [
        styledHeaders[colIndex] ?? "",
        ...styledRows.map((row) => row[colIndex] ?? ""),
      ];
      const maxContentWidth = Math.max(...values.map(visualWidth), MIN_COLUMN_WIDTH);
      const maxWordWidth = Math.max(
        ...values.flatMap((value) =>
          stripAnsi(value)
            .split(/\s+/u)
            .map((word) => stringWidth(word)),
        ),
        MIN_COLUMN_WIDTH,
      );
      return { minWidth: maxWordWidth, maxWidth: Math.max(maxWordWidth, maxContentWidth) };
    });

    const fixedOverhead = numColumns + 1 + numColumns * COLUMN_PADDING;
    const availableWidth = Math.max(0, terminalWidth - fixedOverhead - TABLE_MARGIN);
    const totalMinWidth = constraints.reduce((sum, item) => sum + item.minWidth, 0);
    let finalContentWidths: number[];

    if (totalMinWidth > availableWidth) {
      const shortColumns = constraints.filter((item) => item.maxWidth <= MIN_COLUMN_WIDTH);
      const totalShortColumnWidth = shortColumns.reduce((sum, item) => sum + item.minWidth, 0);
      const finalTotalShortColumnWidth =
        totalShortColumnWidth >= availableWidth ? 0 : totalShortColumnWidth;
      const scale =
        (availableWidth - finalTotalShortColumnWidth) /
          (totalMinWidth - finalTotalShortColumnWidth) || 0;
      finalContentWidths = constraints.map((item) => {
        if (item.maxWidth <= MIN_COLUMN_WIDTH && finalTotalShortColumnWidth > 0)
          return item.minWidth;
        return Math.max(1, Math.floor(item.minWidth * scale));
      });
    } else {
      const surplus = availableWidth - totalMinWidth;
      const totalGrowthNeed = constraints.reduce(
        (sum, item) => sum + (item.maxWidth - item.minWidth),
        0,
      );
      finalContentWidths = constraints.map((item) => {
        if (totalGrowthNeed === 0) return item.minWidth;
        const share = (item.maxWidth - item.minWidth) / totalGrowthNeed;
        return Math.min(item.maxWidth, item.minWidth + Math.floor(surplus * share));
      });
    }

    const actualColumnWidths = Array.from({ length: numColumns }, () => 0);
    const wrapAndProcessRow = (row: string[]) =>
      Array.from({ length: numColumns }, (_, colIndex) => {
        const contentWidth = Math.max(1, finalContentWidths[colIndex] ?? 1);
        const lines = wrapAnsiLines(row[colIndex] ?? "", contentWidth).map((line) => {
          actualColumnWidths[colIndex] = Math.max(
            actualColumnWidths[colIndex] ?? 0,
            visualWidth(line),
          );
          return line;
        });
        return lines;
      });

    const wrappedHeaders = wrapAndProcessRow(styledHeaders);
    const wrappedRows = styledRows.map((row) => wrapAndProcessRow(row));
    const adjustedWidths = actualColumnWidths.map((width) => width + COLUMN_PADDING);
    return { wrappedHeaders, wrappedRows, adjustedWidths };
  }, [headers, rows, terminalWidth, theme]);

  const border = (type: "top" | "middle" | "bottom") => {
    const chars = {
      top: { left: "┌", middle: "┬", right: "┐", horizontal: "─" },
      middle: { left: "├", middle: "┼", right: "┤", horizontal: "─" },
      bottom: { left: "└", middle: "┴", right: "┘", horizontal: "─" },
    }[type];
    return colorize(
      chars.left +
        adjustedWidths
          .map((width) => chars.horizontal.repeat(Math.max(0, width)))
          .join(chars.middle) +
        chars.right,
      theme.border,
    );
  };

  const renderVisualRow = (cells: string[][], isHeader = false): React.ReactNode[] => {
    const maxHeight = Math.max(...cells.map((cell) => cell.length), 1);
    return Array.from({ length: maxHeight }, (_, lineIndex) => {
      const row = cells
        .map((cell, index) => {
          const contentWidth = Math.max(0, (adjustedWidths[index] ?? 0) - COLUMN_PADDING);
          const content = padRightAnsi(cell[lineIndex] ?? "", contentWidth);
          return ` ${isHeader ? chalk.bold(colorize(content, theme.link)) : content} `;
        })
        .join(colorize("│", theme.border));
      return (
        <Text key={lineIndex}>
          {colorize("│", theme.border) + row + colorize("│", theme.border)}
        </Text>
      );
    });
  };

  return (
    <Box flexDirection="column">
      <Text>{border("top")}</Text>
      {renderVisualRow(wrappedHeaders, true)}
      <Text>{border("middle")}</Text>
      {wrappedRows.flatMap((row, rowIndex) =>
        renderVisualRow(row).map((node, lineIndex) => (
          <React.Fragment key={`${rowIndex}-${lineIndex}`}>{node}</React.Fragment>
        )),
      )}
      <Text>{border("bottom")}</Text>
    </Box>
  );
}

function RenderCodeBlock({
  content,
  lang,
  isPending,
  availableTerminalHeight,
  terminalWidth,
  theme,
}: {
  content: string[];
  lang: string | null;
  isPending: boolean;
  availableTerminalHeight?: number;
  terminalWidth: number;
  theme: Theme;
}): React.ReactElement {
  const minLinesForMessage = 1;
  const reservedLines = 2;

  if (isPending && availableTerminalHeight !== undefined) {
    const maxCodeLinesWhenPending = Math.max(0, availableTerminalHeight - reservedLines);
    if (content.length > maxCodeLinesWhenPending) {
      if (maxCodeLinesWhenPending < minLinesForMessage) {
        return (
          <Box paddingLeft={CODE_BLOCK_PREFIX_PADDING}>
            <Text color={theme.textMuted}>... code is being written ...</Text>
          </Box>
        );
      }
      const truncatedContent = content.slice(0, maxCodeLinesWhenPending);
      return (
        <Box paddingLeft={CODE_BLOCK_PREFIX_PADDING} flexDirection="column">
          {colorizeCode({
            code: truncatedContent.join("\n"),
            language: lang,
            maxWidth: terminalWidth - CODE_BLOCK_PREFIX_PADDING,
            theme,
          })}
          <Text color={theme.textMuted}>... generating more ...</Text>
        </Box>
      );
    }
  }

  return (
    <Box
      paddingLeft={CODE_BLOCK_PREFIX_PADDING}
      flexDirection="column"
      width={terminalWidth}
      flexShrink={0}
    >
      {colorizeCode({
        code: content.join("\n"),
        language: lang,
        maxWidth: terminalWidth - CODE_BLOCK_PREFIX_PADDING,
        theme,
      })}
    </Box>
  );
}

function RenderListItem({
  itemText,
  type,
  marker,
  leadingWhitespace,
  theme,
}: {
  itemText: string;
  type: "ul" | "ol";
  marker: string;
  leadingWhitespace?: string;
  theme: Theme;
}): React.ReactElement {
  const prefix = type === "ol" ? `${marker}. ` : `${marker} `;
  const indentation = leadingWhitespace?.length ?? 0;
  return (
    <Box paddingLeft={indentation + LIST_ITEM_PREFIX_PADDING} flexDirection="row">
      <Box width={prefix.length} flexShrink={0}>
        <Text color={theme.text}>{prefix}</Text>
      </Box>
      <Box flexGrow={LIST_ITEM_TEXT_FLEX_GROW}>
        <Text wrap="wrap" color={theme.text}>
          {parseMarkdownToAnsi(itemText, theme, theme.text)}
        </Text>
      </Box>
    </Box>
  );
}

function MarkdownDisplay({
  text,
  isPending,
  availableTerminalHeight,
  terminalWidth,
  renderMarkdown = true,
}: {
  text: string;
  isPending: boolean;
  availableTerminalHeight?: number;
  terminalWidth: number;
  renderMarkdown?: boolean;
  compact?: boolean;
}): React.ReactElement | null {
  const theme = useTheme();

  if (!text) return null;

  if (!renderMarkdown) {
    return (
      <Box paddingLeft={CODE_BLOCK_PREFIX_PADDING} flexDirection="column">
        {colorizeCode({
          code: text,
          language: "markdown",
          maxWidth: terminalWidth - CODE_BLOCK_PREFIX_PADDING,
          theme,
          hideLineNumbers: true,
        })}
      </Box>
    );
  }

  const lines = text.split(/\r?\n/);
  const headerRegex = /^ *(#{1,4}) +(.*)/;
  const codeFenceRegex = /^ *(`{3,}|~{3,}) *([\w-]*?) *$/;
  const ulItemRegex = /^([ \t]*)([-*+]) +(.*)/;
  const olItemRegex = /^([ \t]*)(\d+)\. +(.*)/;
  const hrRegex = /^ *([-*_] *){3,} *$/;
  const tableRowRegex = /^\s*\|(.+)\|\s*$/;
  const tableSeparatorRegex = /^\s*\|?\s*(:?-+:?)\s*(\|\s*(:?-+:?)\s*)+\|?\s*$/;

  const contentBlocks: React.ReactNode[] = [];
  let inCodeBlock = false;
  let lastLineEmpty = true;
  let codeBlockContent: string[] = [];
  let codeBlockLang: string | null = null;
  let codeBlockFence = "";
  let inTable = false;
  let tableRows: string[][] = [];
  let tableHeaders: string[] = [];

  function addContentBlock(block: React.ReactNode): void {
    if (block) {
      contentBlocks.push(block);
      lastLineEmpty = false;
    }
  }

  function flushTable(key: string): void {
    if (tableHeaders.length > 0 && tableRows.length > 0) {
      addContentBlock(
        <RenderTable
          key={key}
          headers={tableHeaders}
          rows={tableRows}
          terminalWidth={terminalWidth}
          theme={theme}
        />,
      );
    }
    inTable = false;
    tableRows = [];
    tableHeaders = [];
  }

  lines.forEach((line, index) => {
    const key = `line-${index}`;

    if (inCodeBlock) {
      const fenceMatch = line.match(codeFenceRegex);
      if (
        fenceMatch &&
        fenceMatch[1]?.startsWith(codeBlockFence[0] ?? "") &&
        fenceMatch[1].length >= codeBlockFence.length
      ) {
        addContentBlock(
          <RenderCodeBlock
            key={key}
            content={codeBlockContent}
            lang={codeBlockLang}
            isPending={isPending}
            availableTerminalHeight={availableTerminalHeight}
            terminalWidth={terminalWidth}
            theme={theme}
          />,
        );
        inCodeBlock = false;
        codeBlockContent = [];
        codeBlockLang = null;
        codeBlockFence = "";
      } else {
        codeBlockContent.push(line);
      }
      return;
    }

    const codeFenceMatch = line.match(codeFenceRegex);
    const headerMatch = line.match(headerRegex);
    const ulMatch = line.match(ulItemRegex);
    const olMatch = line.match(olItemRegex);
    const hrMatch = line.match(hrRegex);
    const tableRowMatch = line.match(tableRowRegex);
    const tableSeparatorMatch = line.match(tableSeparatorRegex);

    if (codeFenceMatch) {
      inCodeBlock = true;
      codeBlockFence = codeFenceMatch[1] ?? "```";
      codeBlockLang = codeFenceMatch[2] || null;
    } else if (tableRowMatch && !inTable) {
      if (index + 1 < lines.length && tableSeparatorRegex.test(lines[index + 1] ?? "")) {
        inTable = true;
        tableHeaders = tableRowMatch[1]?.split("|").map((cell) => cell.trim()) ?? [];
        tableRows = [];
      } else {
        addContentBlock(
          <Box key={key}>
            <Text wrap="wrap" color={theme.text}>
              {parseMarkdownToAnsi(line, theme, theme.text)}
            </Text>
          </Box>,
        );
      }
    } else if (inTable && tableSeparatorMatch) {
      // Skip separator line.
    } else if (inTable && tableRowMatch) {
      const cells = tableRowMatch[1]?.split("|").map((cell) => cell.trim()) ?? [];
      while (cells.length < tableHeaders.length) cells.push("");
      if (cells.length > tableHeaders.length) cells.length = tableHeaders.length;
      tableRows.push(cells);
    } else if (inTable && !tableRowMatch) {
      flushTable(`table-${contentBlocks.length}`);
      if (line.trim().length > 0) {
        addContentBlock(
          <Box key={key}>
            <Text wrap="wrap" color={theme.text}>
              {parseMarkdownToAnsi(line, theme, theme.text)}
            </Text>
          </Box>,
        );
      }
    } else if (hrMatch) {
      addContentBlock(
        <Box key={key}>
          <Text dimColor>---</Text>
        </Box>,
      );
    } else if (headerMatch) {
      const level = headerMatch[1]?.length ?? 1;
      const headerText = headerMatch[2] ?? "";
      const color = level <= 2 ? theme.link : level === 4 ? theme.textMuted : theme.text;
      addContentBlock(
        <Box key={key}>
          <Text bold={level <= 3} italic={level === 4} color={color}>
            {parseMarkdownToAnsi(headerText, theme, color)}
          </Text>
        </Box>,
      );
    } else if (ulMatch) {
      addContentBlock(
        <RenderListItem
          key={key}
          itemText={ulMatch[3] ?? ""}
          type="ul"
          marker={ulMatch[2] ?? "-"}
          leadingWhitespace={ulMatch[1] ?? ""}
          theme={theme}
        />,
      );
    } else if (olMatch) {
      addContentBlock(
        <RenderListItem
          key={key}
          itemText={olMatch[3] ?? ""}
          type="ol"
          marker={olMatch[2] ?? "1"}
          leadingWhitespace={olMatch[1] ?? ""}
          theme={theme}
        />,
      );
    } else if (line.trim().length === 0 && !inCodeBlock) {
      if (!lastLineEmpty) {
        contentBlocks.push(<Box key={`spacer-${index}`} height={EMPTY_LINE_HEIGHT} />);
        lastLineEmpty = true;
      }
    } else {
      addContentBlock(
        <Box key={key}>
          <Text wrap="wrap" color={theme.text}>
            {parseMarkdownToAnsi(line, theme, theme.text)}
          </Text>
        </Box>,
      );
    }
  });

  if (inCodeBlock) {
    addContentBlock(
      <RenderCodeBlock
        key="line-eof"
        content={codeBlockContent}
        lang={codeBlockLang}
        isPending={isPending}
        availableTerminalHeight={availableTerminalHeight}
        terminalWidth={terminalWidth}
        theme={theme}
      />,
    );
  }

  if (inTable) flushTable(`table-${contentBlocks.length}`);

  return <>{contentBlocks}</>;
}

export const Markdown = React.memo(function Markdown({
  children,
  width: explicitWidth,
  compact = false,
  renderMarkdown = true,
  isPending = false,
  availableTerminalHeight,
}: MarkdownProps) {
  const { stdout } = useStdout();
  const terminalWidth = explicitWidth ?? Math.max(40, (stdout?.columns || 80) - 4);
  const text = compact ? children.trim() : children;

  if (!text) return null;

  return (
    <Box flexDirection="column" flexShrink={1}>
      <MarkdownDisplay
        text={stripUnsafeCharacters(text)}
        isPending={isPending}
        availableTerminalHeight={availableTerminalHeight}
        terminalWidth={terminalWidth}
        renderMarkdown={renderMarkdown}
        compact={compact}
      />
    </Box>
  );
});

export const StreamingMarkdown = React.memo(function StreamingMarkdown({
  children,
  width,
  compact = false,
}: {
  children: string;
  width: number;
  compact?: boolean;
}) {
  return (
    <Markdown width={width} compact={compact} isPending>
      {children}
    </Markdown>
  );
});
