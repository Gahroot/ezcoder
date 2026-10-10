// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { GoalWorld, describeWorld, farmScale, fitFarm } from "./GoalWorld";
import { FARM_CORE } from "./goal-farm-map";
import { TILE } from "./goal-map-ground";
import { COORDINATOR_KEY } from "./goal-world-agents";

beforeAll(() => {
  // No canvas in jsdom: the picture is decoration, the summary carries the facts.
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
  // jsdom has no ResizeObserver; the world only needs it to size its canvas.
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
});

afterEach(cleanup);

describe("GoalWorld", () => {
  it("always fits the whole farmstead, scaling smoothly with the window", () => {
    // Regression: the scale was a whole number, so a window a little smaller
    // than full screen dropped from 2x to 1x and the farm suddenly halved.
    const coreW = FARM_CORE.cols * TILE;
    const coreH = FARM_CORE.rows * TILE;
    let previous = 0;
    for (const w of [800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700]) {
      const h = Math.round(w * 0.62);
      const f = fitFarm(w, h, 56);
      // The whole farmstead is on screen, below the header.
      expect(coreW * f.scale).toBeLessThanOrEqual(w + 0.5);
      expect(coreH * f.scale).toBeLessThanOrEqual(h - 56 + 0.5);
      // And it fills one side: as big as it can be, never a halved farm.
      const filled = Math.max((coreW * f.scale) / w, (coreH * f.scale) / (h - 56));
      expect(filled).toBeGreaterThan(0.99);
      // A bigger window never shows a smaller farm.
      expect(f.scale).toBeGreaterThanOrEqual(previous);
      previous = f.scale;
    }
    expect(farmScale(coreW * 2, coreH * 2)).toBe(2);
  });

  it("builds a map that covers the stage edge to edge, keeping the farmstead below the header", () => {
    for (const [w, h] of [
      [1728, 1080],
      [960, 640],
      [1400, 600],
    ] as const) {
      const f = fitFarm(w, h, 56);
      const cell = TILE * f.scale;
      expect(f.cols * cell).toBeGreaterThanOrEqual(w - 0.5);
      expect(f.rows * cell).toBeGreaterThanOrEqual(h - 0.5);
      expect(f.cols).toBeGreaterThanOrEqual(FARM_CORE.cols);
      expect(f.rows).toBeGreaterThanOrEqual(FARM_CORE.rows);
      expect(f.top * cell).toBeGreaterThanOrEqual(56);
    }
  });

  it("is the whole view: no roster, no input, and the facts in a hidden live summary", () => {
    render(
      <GoalWorld
        goalId="seo"
        running
        liveTools={
          [{ id: "a", name: "read", args: { file_path: "/x/a.ts" }, status: "running" }] as never
        }
        waitingOnUser={false}
        workers={[
          {
            key: "g:1",
            agentName: "researcher",
            label: "researcher",
            status: "running",
            activity: "Searching web for seo",
            tokens: "",
            durationMs: 0,
            toolUseCount: 1,
          },
        ]}
      />,
    );
    const view = screen.getByRole("region", { name: "Workers" });
    expect(view.querySelector("canvas")).not.toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(view.textContent).toBe("GG Goals: Reading a.ts. researcher: Searching web for seo.");
  });

  it("describes finished and stopped workers plainly", () => {
    expect(
      describeWorld([
        {
          key: COORDINATOR_KEY,
          agentName: undefined,
          name: "GG Goals",
          coordinator: true,
          status: "idle",
          kind: null,
          detail: "Ready when you are",
        },
        {
          key: "w",
          agentName: "worker",
          name: "worker",
          coordinator: false,
          status: "error",
          kind: null,
          detail: "Stopped",
        },
      ]),
    ).toBe("GG Goals: Ready when you are. worker: stopped.");
  });
});
