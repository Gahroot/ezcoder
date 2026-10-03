import { describe, expect, it } from "vitest";
import { CRITTERS, CRITTER_CELLS } from "./critter-sprites";
import { EZ_FACE_GLOW, ezFaceRows, renderEzFace, type EzFaceFrame } from "./ez-face";

const FRAMES = [
  "ready",
  "blink",
  "happy",
  "curious",
  "worried",
  "sad",
  "shocked",
] as const satisfies readonly EzFaceFrame[];
const robot = CRITTERS.find((c) => c.id === "robot");

describe("ez-face", () => {
  it.each(FRAMES)("%s is a full critter-sized grid", (frame) => {
    const rows = ezFaceRows(frame);
    expect(rows).toHaveLength(CRITTER_CELLS);
    for (const row of rows) expect(row).toHaveLength(CRITTER_CELLS);
  });

  it("is the Robot critter everywhere but its screen (rows 5–7)", () => {
    const ready = ezFaceRows("ready");
    expect(robot).toBeDefined();
    robot?.rows.forEach((row, y) => {
      if (y < 5 || y > 7) expect(ready[y], `row ${y}`).toBe(row);
    });
  });

  it("gives every frame a different face", () => {
    expect(new Set(FRAMES.map((f) => ezFaceRows(f).join("\n"))).size).toBe(FRAMES.length);
  });

  it("only changes the face and its marks, keeping the body", () => {
    const base = ezFaceRows("ready");
    for (const frame of FRAMES) {
      ezFaceRows(frame).forEach((row, y) => {
        if (y >= 10) expect(row, `${frame} row ${y}`).toBe(base[y]);
      });
    }
  });

  it.each(Object.entries(EZ_FACE_GLOW))("%s glows in its status colour", (mood, glow) => {
    const svg = decodeURIComponent(renderEzFace(mood as EzFaceFrame));
    expect(svg).toContain(`fill="${glow}"`);
  });
});
