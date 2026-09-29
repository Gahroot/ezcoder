import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { StructuredToolResult } from "@prestyj/agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { findMotionBundle, type MotionBundle } from "../core/skills.js";
import { createMotionCheckTool } from "./motion-check-tool.js";

const exec = promisify(execFile);
const runtimeReport = {
  ok: true,
  lint: { filesScanned: 1, errorCount: 0 },
  runtime: { errorCount: 0 },
  layout: { samples: [0.5], errorCount: 0 },
  contrast: { enabled: true, samples: [0.5], errorCount: 0 },
};
const summarySchema = z.object({
  technical: z.boolean(),
  checks: z.array(z.object({ name: z.string(), ok: z.boolean() })),
  visual: z.string(),
});
function summary(result: string | StructuredToolResult): z.infer<typeof summarySchema> {
  if (typeof result === "string") return summarySchema.parse(JSON.parse(result));
  if (typeof result.content === "string") return summarySchema.parse(JSON.parse(result.content));
  const text = result.content.find((part) => part.type === "text");
  if (text?.type !== "text") throw new Error("Missing technical report");
  return summarySchema.parse(JSON.parse(text.text));
}
let root = "";
let bundle: MotionBundle;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "motion-single-pass-"));
  const installed = await findMotionBundle();
  if (!installed) throw new Error("Missing Motion bundle");
  bundle = { ...installed, launcher: path.join(root, "runtime.mjs") };
  await fs.mkdir(path.join(root, "renders"));
  await fs.writeFile(path.join(root, "index.html"), "<div>fixture</div>");
  await setRuntime(runtimeReport);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});
async function setRuntime(report: unknown): Promise<void> {
  await fs.writeFile(
    bundle.launcher,
    `import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(path.join(root, "calls.jsonl"))}, JSON.stringify(process.argv.slice(2))+'\\n');
console.log(${JSON.stringify(JSON.stringify(report))});`,
  );
}
async function render(audio?: "quiet" | "clipped", still = false): Promise<void> {
  await exec("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    still
      ? "color=c=red:size=320x180:rate=24:duration=2"
      : "testsrc2=size=320x180:rate=24:duration=2",
    ...(audio
      ? [
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=48000:duration=2",
          "-af",
          audio === "quiet" ? "volume=0.2" : "volume=20",
          "-c:a",
          "aac",
        ]
      : []),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    path.join(root, "renders", "video.mp4"),
  ]);
}
async function check(
  extra: { slideshowRequested?: boolean; output?: string } = {},
): Promise<string | StructuredToolResult> {
  return createMotionCheckTool(root, bundle).execute(
    {
      project: ".",
      output: "renders/video.mp4",
      windows: [{ label: "Reveal", start: 0, end: 0.5 }],
      ...extra,
    },
    { signal: new AbortController().signal, toolCallId: "single-pass" },
  );
}

describe("Motion single-pass output check", () => {
  it("runs one runtime check including lint and returns real images to the working agent", async () => {
    await render();
    const before = await fs.readFile(path.join(root, "renders", "video.mp4"));
    const result = await check();
    expect(summary(result).technical).toBe(true);
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") throw new Error(result);
    if (typeof result.content === "string") throw new Error("Expected image content");
    const images = result.content.filter((part) => part.type === "image");
    expect(images).toHaveLength(3);
    for (const image of images) expect(image.data).toMatch(/^\/9j\//);
    expect(summary(result).visual).toContain("No creative approval has been granted");
    const calls = (await fs.readFile(path.join(root, "calls.jsonl"), "utf8")).trim().split("\n");
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0] ?? "null")).toEqual([
      "check",
      await fs.realpath(root),
      "--json",
      "--contrast",
      "--at-transitions",
    ]);
    expect(await fs.readFile(path.join(root, "renders", "video.mp4"))).toEqual(before);
    expect(summary(result).checks.some((item) => item.name === "Audio levels")).toBe(false);
  });
  it.each(["quiet", "clipped"] as const)(
    "measures %s audio without imposing a generic mix target",
    async (audio) => {
      await render(audio);
      const result = summary(await check());
      expect(result.checks).toContainEqual({
        name: "Audio is finite and not clipping",
        ok: audio === "quiet",
      });
      expect(result.technical).toBe(audio === "quiet");
    },
  );
  it("honors configured FFmpeg and sibling ffprobe without PATH", async () => {
    await render("quiet");
    const located = await exec(process.platform === "win32" ? "where.exe" : "which", ["ffmpeg"]);
    const binary = located.stdout.trim().split(/\r?\n/)[0];
    if (!binary || !path.isAbsolute(binary)) throw new Error("Expected installed FFmpeg");
    vi.stubEnv("HYPERFRAMES_FFMPEG_PATH", binary);
    vi.stubEnv("PATH", "");
    expect(summary(await check()).technical).toBe(true);
  });
  it.each([
    { ok: true },
    { ...runtimeReport, contrast: { enabled: false, samples: [], errorCount: 0 } },
  ])("rejects a success-looking incomplete runtime report: %j", async (report) => {
    await setRuntime(report);
    await render();
    const result = summary(await check());
    expect(result.technical).toBe(false);
    expect(result.checks).toContainEqual({ name: "Structured runtime report", ok: false });
  });
  it.each([false, true])(
    "does not excuse frozen output without explicit slideshow intent (%s)",
    async (slideshowRequested) => {
      await render(undefined, true);
      expect(summary(await check({ slideshowRequested })).technical).toBe(slideshowRequested);
    },
  );
  it("rejects workspace path escapes before running any check", async () => {
    expect(summary(await check({ output: "../outside.mp4" })).technical).toBe(false);
    await expect(fs.access(path.join(root, "calls.jsonl"))).rejects.toThrow();
  });
  it("honors cancellation before launching processes", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      createMotionCheckTool(root, bundle).execute(
        {
          project: ".",
          output: "renders/video.mp4",
          windows: [{ label: "Reveal", start: 0, end: 0.5 }],
        },
        {
          signal: controller.signal,
          toolCallId: "cancel",
        },
      ),
    ).rejects.toThrow("cancelled");
    await expect(fs.access(path.join(root, "calls.jsonl"))).rejects.toThrow();
  });
});
