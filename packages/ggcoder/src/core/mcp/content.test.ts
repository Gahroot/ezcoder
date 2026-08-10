import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { toToolResult } from "./content.js";
import { boundedSize } from "../../utils/image.js";

/** Mirrors the private cap in utils/image.ts — kept local rather than widening that module's API. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

async function pngBase64(width: number, height: number): Promise<string> {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
  return buffer.toString("base64");
}

describe("toToolResult", () => {
  it("keeps a text-only response a plain string", async () => {
    const result = await toToolResult([{ type: "text", text: "hello" }], "mcp__x__y");
    expect(result).toBe("hello");
  });

  it("reports an empty response when there is nothing usable", async () => {
    expect(await toToolResult([], "mcp__x__y")).toBe("(empty response)");
    expect(await toToolResult([{ type: "audio", data: "aGk=" }], "mcp__x__y")).toBe(
      "(empty response)",
    );
  });

  it("forwards an image-only response instead of dropping it", async () => {
    const data = await pngBase64(8, 8);
    const result = await toToolResult(
      [{ type: "image", data, mimeType: "image/png" }],
      "mcp__s__t",
    );

    expect(typeof result).not.toBe("string");
    const parts = (result as { content: { type: string }[] }).content;
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: "image", mediaType: "image/png" });
  });

  it("puts text before images so it frames them", async () => {
    const data = await pngBase64(8, 8);
    const result = await toToolResult(
      [
        { type: "text", text: "here is the chart" },
        { type: "image", data, mimeType: "image/png" },
      ],
      "mcp__s__t",
    );

    const parts = (result as { content: { type: string; text?: string }[] }).content;
    expect(parts.map((p) => p.type)).toEqual(["text", "image"]);
    expect(parts[0]?.text).toBe("here is the chart");
  });

  // A third-party server can return a screenshot far larger than any provider
  // accepts; forwarding it verbatim would fail the whole turn.
  it("shrinks an oversized image to fit provider limits", async () => {
    const huge = boundedSize(8000, 8000);
    const data = await pngBase64(8000, 8000);
    expect(Buffer.from(data, "base64").length).toBeGreaterThan(0);

    const result = await toToolResult(
      [{ type: "image", data, mimeType: "image/png" }],
      "mcp__s__t",
    );
    const parts = (result as { content: { type: string; data?: string }[] }).content;
    const image = parts.find((p) => p.type === "image");
    const bytes = Buffer.from(image?.data ?? "", "base64");

    expect(bytes.length).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    const meta = await sharp(bytes).metadata();
    expect(meta.width).toBeLessThanOrEqual(huge.width);
  });

  // Providers reject a media type the bytes contradict.
  it("corrects a media type the payload disagrees with", async () => {
    const data = await pngBase64(8, 8);
    const result = await toToolResult(
      [{ type: "image", data, mimeType: "image/jpeg" }],
      "mcp__s__t",
    );
    const parts = (result as { content: { type: string; mediaType?: string }[] }).content;
    expect(parts.find((p) => p.type === "image")?.mediaType).toBe("image/png");
  });

  it("degrades an unreadable image to a note and keeps the text", async () => {
    const result = await toToolResult(
      [
        { type: "text", text: "rendered" },
        { type: "image", data: "bm90LWFuLWltYWdl", mimeType: "image/png" },
      ],
      "mcp__s__t",
    );

    const parts = (result as { content: { type: string; text?: string }[] }).content;
    expect(parts[0]?.text).toBe("rendered");
    expect(parts[1]?.text).toContain("unreadable image");
  });

  it("caps how many images one call can forward", async () => {
    const data = await pngBase64(8, 8);
    const many = Array.from({ length: 7 }, () => ({
      type: "image",
      data,
      mimeType: "image/png",
    }));

    const result = await toToolResult(many, "mcp__s__t");
    const parts = (result as { content: { type: string; text?: string }[] }).content;

    expect(parts.filter((p) => p.type === "image")).toHaveLength(4);
    expect(parts[0]?.text).toContain("3 further images omitted");
  });
});
