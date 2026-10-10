import { describe, expect, it } from "vitest";
import { composeMap } from "./goal-map-compose";
import { TILE } from "./goal-map-ground";
import { MAP_COLS, MAP_ROWS, MOCKUPS } from "./goal-map-mockups";
import { E } from "./goal-map-pixels";

describe("top-down goal map mockups", () => {
  it("paints every world at its map size", () => {
    expect(MOCKUPS.map((m) => m.id)).toEqual([
      "1-homestead",
      "2-village",
      "3-hillside",
      "3b-cozy-hillside",
      "6-farmstead",
      "4-harbour",
      "5-workshop",
    ]);
    for (const m of MOCKUPS) {
      const scene = m.build();
      const buf = composeMap(scene);
      expect([buf.width, buf.height]).toEqual([scene.grid.cols * TILE, scene.grid.rows * TILE]);
    }
    // The original five share the standard map size.
    const homestead = MOCKUPS[0]?.build();
    expect(homestead && [homestead.grid.cols, homestead.grid.rows]).toEqual([MAP_COLS, MAP_ROWS]);
  });

  it("paints the same world the same way every time", () => {
    const build = MOCKUPS[0]?.build;
    if (!build) throw new Error("no mockups");
    const a = composeMap(build()).data;
    const b = composeMap(build()).data;
    expect(a.length).toBe(b.length);
    expect(a.every((value, i) => value === b[i])).toBe(true);
  });

  it("keeps a terrace's top as grass, with only its edge in shade", () => {
    // Regression: the rim test matched every pixel more than a cliff-height
    // above the foot, so whole terraces were painted the rim's dark teal.
    const hillside = MOCKUPS.find((m) => m.id === "3-hillside");
    if (!hillside) throw new Error("no hillside");
    const buf = composeMap(hillside.build());
    // The middle of the top terrace (row 2) and of the middle terrace (row 13),
    // away from props and paths.
    for (const [x, y] of [
      [TILE * 6 + 8, TILE * 2 + 8],
      [TILE * 20 + 8, TILE * 14 + 4],
    ] as const) {
      expect(buf.rgb(x, y)).not.toBe(E.teal0);
    }
  });
});
