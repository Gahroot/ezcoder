import { describe, expect, it } from "vitest";
import { CRITTER_CELLS } from "./critter-sprites";
import {
  NOLAN_FACE_PALETTE,
  nolanFaceRows,
  renderNolanFace,
  type NolanFaceFrame,
} from "./nolan-face";

const FRAMES: readonly NolanFaceFrame[] = ["base", "blink", "talk", "happy", "sleepy"];

describe("Nolan's face", () => {
  it.each(FRAMES)("%s is a full 14×14 grid with every colour defined", (frame) => {
    const rows = nolanFaceRows(frame);
    expect(rows).toHaveLength(CRITTER_CELLS);
    for (const row of rows) {
      expect(row).toHaveLength(CRITTER_CELLS);
      for (const ch of row) {
        if (ch !== ".") expect(NOLAN_FACE_PALETTE[ch], `${frame} "${ch}"`).toBeDefined();
      }
    }
  });

  it("gives every expression its own look", () => {
    const rendered = FRAMES.map(renderNolanFace);
    expect(new Set(rendered).size).toBe(FRAMES.length);
  });

  it("only changes the eyes and mouth, so stacked frames line up", () => {
    const base = nolanFaceRows("base");
    for (const frame of FRAMES) {
      nolanFaceRows(frame).forEach((row, i) => {
        if (row !== base[i]) expect([6, 7, 9, 10], `${frame} row ${i}`).toContain(i);
      });
    }
  });

  it("renders a deterministic 14×14 SVG", () => {
    const svg = decodeURIComponent(renderNolanFace("base"));
    expect(svg).toContain('viewBox="0 0 14 14"');
    expect(renderNolanFace("base")).toBe(renderNolanFace("base"));
  });
});
