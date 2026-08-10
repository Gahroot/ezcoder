import type { ToolExecuteResult } from "@kenkaiiii/gg-agent";
import { log } from "../logger.js";
import { shrinkToFit } from "../../utils/image.js";

/** Media types a provider will accept as an image part. */
const SUPPORTED_IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Cap on image parts forwarded from a single tool call. An MCP server is
 * third-party code and can return an unbounded array; each image costs real
 * tokens, so keep the rest as a counted note rather than silently blowing up
 * the turn.
 */
const MAX_IMAGES_PER_RESULT = 4;

interface McpImagePart {
  data: string;
  mimeType: string;
}

/**
 * An MCP image part, per spec: `{ type: "image", data: <base64>, mimeType }`.
 * Validated structurally because the payload crosses a trust boundary — a
 * server can send anything, including a `type` that lies about the shape.
 */
function asImagePart(item: unknown): McpImagePart | null {
  if (item == null || typeof item !== "object") return null;
  const part = item as Record<string, unknown>;
  if (part.type !== "image") return null;
  if (typeof part.data !== "string" || part.data.length === 0) return null;
  const mimeType = typeof part.mimeType === "string" ? part.mimeType : "image/png";
  return { data: part.data, mimeType };
}

function asText(item: unknown): string | null {
  if (item == null || typeof item !== "object") return null;
  const part = item as Record<string, unknown>;
  return typeof part.text === "string" ? part.text : null;
}

/**
 * Convert an MCP tool's content array into a result the model can actually
 * consume, preserving image parts instead of dropping them.
 *
 * Text-only results stay plain strings so the overwhelmingly common path keeps
 * its existing shape (and the agent loop's string budgeting still applies).
 * Images are re-encoded through {@link shrinkToFit}, the same helper the `read`
 * tool uses: an unbounded screenshot from a third-party server would otherwise
 * exceed provider size limits and fail the whole turn. A media type the buffer
 * contradicts is corrected there too, since providers reject mismatches.
 *
 * Every image failure degrades to a text note: a partially readable answer beats
 * an error, and the model is told what it is not seeing rather than silently
 * receiving less than the server sent.
 */
export async function toToolResult(
  content: unknown[],
  toolName: string,
): Promise<ToolExecuteResult> {
  const texts: string[] = [];
  const rawImages: McpImagePart[] = [];

  for (const item of content) {
    const image = asImagePart(item);
    if (image) {
      rawImages.push(image);
      continue;
    }
    const text = asText(item);
    if (text !== null) texts.push(text);
  }

  if (rawImages.length === 0) {
    return texts.join("\n") || "(empty response)";
  }

  const dropped = rawImages.length - MAX_IMAGES_PER_RESULT;
  const kept = dropped > 0 ? rawImages.slice(0, MAX_IMAGES_PER_RESULT) : rawImages;

  const parts: (
    | { type: "text"; text: string }
    | {
        type: "image";
        mediaType: string;
        data: string;
      }
  )[] = [];

  for (const image of kept) {
    try {
      const raw = Buffer.from(image.data, "base64");
      if (raw.length === 0) {
        parts.push({ type: "text", text: `[${toolName} returned an empty image]` });
        continue;
      }
      const { buffer, mediaType } = await shrinkToFit(raw, image.mimeType);
      if (!SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType)) {
        parts.push({
          type: "text",
          text: `[${toolName} returned an image in unsupported format ${mediaType}]`,
        });
        continue;
      }
      parts.push({ type: "image", mediaType, data: buffer.toString("base64") });
    } catch (err) {
      // A malformed or undecodable image must not fail the tool call: the text
      // parts of the same response are often the substantive answer.
      const reason = err instanceof Error ? err.message : String(err);
      log("WARN", "mcp", "Dropping unreadable MCP image part", { tool: toolName, reason });
      parts.push({ type: "text", text: `[${toolName} returned an unreadable image]` });
    }
  }

  const notes: string[] = [...texts];
  if (dropped > 0) {
    notes.push(`[${dropped} further image${dropped === 1 ? "" : "s"} omitted]`);
  }

  // Text first: it frames the images for the model, and matches `read`'s order.
  const leading = notes.join("\n");
  return { content: leading ? [{ type: "text", text: leading }, ...parts] : parts };
}
