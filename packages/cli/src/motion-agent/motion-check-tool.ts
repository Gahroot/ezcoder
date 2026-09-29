import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentTool, StructuredToolResult } from "@prestyj/agent";
import { z } from "zod";
import { log } from "../core/logger.js";
import type { MotionBundle } from "../core/skills.js";
import {
  isMotionTechnicalReport,
  motionPath,
  motionRegistrationSchema,
  validateMotionManifest,
} from "./motion-review.js";

const exec = promisify(execFile);
const parameters = motionRegistrationSchema.omit({ depth: true, references: true });
const binariesSchema = z.object({
  ffmpeg: z.string().refine(path.isAbsolute),
  ffprobe: z.string().refine(path.isAbsolute),
});
const audioSchema = z.object({ streams: z.array(z.object({ codec_type: z.literal("audio") })) });
const levelsSchema = z.object({ input_i: z.string(), input_tp: z.string() });
const pixelsSchema = z.object({
  ok: z.literal(true),
  videoSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

/** One explicit check; the working agent sees the frames, with no separate model or approval loop. */
export function createMotionCheckTool(
  cwd: string,
  bundle: MotionBundle,
): AgentTool<typeof parameters> {
  return {
    name: "motion_check",
    description:
      "Check a current rendered Motion video once: source lint/runtime/layout/contrast, decoded pixels, " +
      "and audio levels when present. Returns technical findings plus actual rendered images for YOU " +
      "to inspect against the selected template/component and inputs. Supply representative action " +
      "windows (start/end seconds); for videos over 180 seconds select a range to inspect. " +
      "This does not approve creative quality or watch/listen to the full video. Do not repeat the " +
      "same checks manually or recheck an unchanged export. All paths must stay inside the workspace.",
    parameters,
    executionMode: "sequential",
    async execute(args, context): Promise<string | StructuredToolResult> {
      const started = Date.now();
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(240_000)]);
      const checks: { name: string; ok: boolean; details: string }[] = [];
      let config: string | undefined;
      let technical = false;
      try {
        const input = parameters.parse(args);
        signal.throwIfAborted();
        const project = await motionPath(cwd, input.project);
        const output = await motionPath(cwd, input.output);
        const holds = input.holds ? await motionPath(cwd, input.holds) : undefined;
        if (!(await fs.stat(project)).isDirectory()) throw new Error("Expected a project folder");
        const outputInfo = await fs.stat(output);
        if (!outputInfo.isFile() || outputInfo.size > 2 * 1024 ** 3)
          throw new Error("Expected a rendered video file under 2 GiB");
        const run = async (
          name: string,
          binary: string,
          argv: string[],
        ): Promise<{ stdout: string; stderr: string } | null> => {
          try {
            const result = await exec(binary, argv, {
              signal,
              timeout: 120_000,
              maxBuffer: 1024 * 1024,
              windowsHide: true,
            });
            checks.push({
              name,
              ok: true,
              details: `${result.stdout}\n${result.stderr}`.slice(0, 12_000),
            });
            return result;
          } catch (error) {
            signal.throwIfAborted();
            checks.push({ name, ok: false, details: String(error).slice(0, 12_000) });
            return null;
          }
        };
        const validate = (name: string, ok: boolean): void => {
          checks.push({ name, ok, details: ok ? "passed" : "Missing or failed check evidence" });
        };
        // HyperFrames check includes lint; running `hf lint` separately duplicates that work.
        const runtime = await run("Runtime/layout/contrast (includes lint)", process.execPath, [
          bundle.launcher,
          "check",
          project,
          "--json",
          "--contrast",
          "--at-transitions",
        ]);
        validate(
          "Structured runtime report",
          runtime !== null && isMotionTechnicalReport(runtime.stdout),
        );
        const pixels = await run("Decoded pixel motion", process.execPath, [
          path.join(bundle.root, "bin", "motion-check.mjs"),
          output,
          ...(holds ? ["--holds", holds] : []),
          ...(input.slideshowRequested ? ["--slideshow-requested"] : []),
        ]);
        const pixelReport = pixels ? pixelsSchema.safeParse(JSON.parse(pixels.stdout)) : null;
        validate("Structured pixel report", pixelReport?.success === true);
        const binaries = await exec(
          process.execPath,
          [path.join(bundle.root, "bin", "media-binaries.mjs")],
          {
            signal,
            timeout: 10_000,
            maxBuffer: 64 * 1024,
            windowsHide: true,
          },
        );
        const { ffmpeg, ffprobe } = binariesSchema.parse(JSON.parse(binaries.stdout));
        const audio = await run("Audio metadata", ffprobe, [
          "-v",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-select_streams",
          "a",
          "-show_entries",
          "stream=codec_type",
          "-of",
          "json",
          output,
        ]);
        const streams = audio ? audioSchema.safeParse(JSON.parse(audio.stdout)) : null;
        validate("Structured audio report", streams?.success === true);
        if (streams?.success && streams.data.streams.length > 0) {
          const levels = await run("Audio levels", ffmpeg, [
            "-hide_banner",
            "-nostdin",
            "-xerror",
            "-protocol_whitelist",
            "file,pipe",
            "-i",
            output,
            "-vn",
            "-af",
            "loudnorm=I=-14:TP=-1:LRA=11:print_format=json",
            "-f",
            "null",
            "-",
          ]);
          if (levels) {
            const start = levels.stderr.lastIndexOf("\n{");
            const end = levels.stderr.indexOf("\n}", start);
            if (start < 0 || end < 0) throw new Error("Missing structured audio measurements");
            const measured = levelsSchema.parse(JSON.parse(levels.stderr.slice(start, end + 2)));
            const loudness = Number(measured.input_i);
            const peak = Number(measured.input_tp);
            // Measure, don't impose a new mix on a source-backed recipe. Clipping is a failure;
            // distribution-specific loudness targets remain the recipe/user's contract.
            validate(
              "Audio is finite and not clipping",
              Number.isFinite(loudness) && Number.isFinite(peak) && peak <= 0,
            );
          }
        }
        const id = randomUUID();
        const directory = path.join(path.dirname(output), `.motion-review-${id}`);
        config = path.join(os.tmpdir(), `ez-motion-check-${id}.json`);
        await fs.writeFile(config, JSON.stringify({ windows: input.windows, range: input.range }), {
          flag: "wx",
          signal,
        });
        const frames = await run("Rendered frames", process.execPath, [
          path.join(bundle.root, "bin", "review-frames.mjs"),
          output,
          directory,
          config,
        ]);
        if (!frames)
          return JSON.stringify({ technical: false, output, checks, visual: "not inspected" });
        const evidence = await validateMotionManifest(
          directory,
          output,
          input.windows,
          signal,
          input.range,
        );
        validate(
          "Pixel report matches rendered frames",
          pixelReport?.success === true &&
            pixelReport.data.videoSha256 === evidence.manifest.video.sha256,
        );
        technical = checks.every((check) => check.ok);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                technical,
                output,
                checks,
                coverage: evidence.manifest.range,
                visual:
                  "Inspect the attached rendered frames against the selected recipe and inputs. These are samples, not playback or audio listening. No creative approval has been granted.",
              }),
            },
            ...evidence.images.map((image) => ({
              type: "image" as const,
              mediaType: "image/jpeg",
              data: image.toString("base64"),
            })),
          ],
        };
      } catch (error) {
        if (context.signal.aborted) throw context.signal.reason;
        return JSON.stringify({
          technical: false,
          checks,
          error: String(error).slice(0, 4000),
          visual: "unverified",
        });
      } finally {
        if (config) await fs.rm(config, { force: true });
        log("INFO", "motion-check", "Output check finished", {
          project: args.project,
          output: args.output,
          elapsedMs: Date.now() - started,
          technical,
        });
      }
    },
  };
}
