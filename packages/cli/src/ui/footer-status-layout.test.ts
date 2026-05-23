import { describe, expect, it } from "vitest";
import { getFooterStatusLayoutDecision } from "./components/BackgroundTasksBar.js";
import { getFooterRightLength, getGoalFooterLabel } from "./components/Footer.js";

describe("footer status layout decisions", () => {
  it("keeps a single wide row when footer status indicators are present", () => {
    expect(
      getFooterStatusLayoutDecision({
        columns: 140,
        backgroundTaskCount: 2,
        updatePending: true,
      }),
    ).toEqual({
      hasBackgroundTasks: true,
      hasUpdateNotice: true,
      stack: false,
      compactBackgroundTasks: false,
    });
  });

  it("uses compact background task copy before stacking is needed", () => {
    expect(
      getFooterStatusLayoutDecision({
        columns: 110,
        backgroundTaskCount: 1,
        updatePending: true,
      }),
    ).toMatchObject({
      stack: false,
      compactBackgroundTasks: true,
    });
  });

  it("stacks crowded status indicators on narrow terminals to avoid collisions", () => {
    expect(
      getFooterStatusLayoutDecision({
        columns: 80,
        backgroundTaskCount: 1,
        updatePending: true,
      }),
    ).toEqual({
      hasBackgroundTasks: true,
      hasUpdateNotice: true,
      stack: true,
      compactBackgroundTasks: true,
    });
  });

  it("does not stack a lone update notice", () => {
    expect(
      getFooterStatusLayoutDecision({
        columns: 60,
        backgroundTaskCount: 0,
        updatePending: true,
      }),
    ).toMatchObject({
      hasBackgroundTasks: false,
      hasUpdateNotice: true,
      stack: false,
    });
  });
});

describe("main footer Goal mode layout", () => {
  it("labels Goal mode states compactly", () => {
    expect(getGoalFooterLabel(undefined)).toBe("Goal off");
    expect(getGoalFooterLabel("off")).toBe("Goal off");
    expect(getGoalFooterLabel("planner")).toBe("Goal plan");
    expect(getGoalFooterLabel("setup")).toBe("Goal setup");
    expect(getGoalFooterLabel("coordinator")).toBe("Goal coord");
  });

  it("includes the Goal label and separator in right-side width calculations", () => {
    const withoutGoalWidth = 8 + 1 + 2 + 1 + 3 + "Sonnet".length + 3 + "Thinking off".length;

    expect(
      getFooterRightLength({
        barWidth: 8,
        contextPct: 12,
        modelName: "Sonnet",
        goalText: "Goal coord",
        thinkingText: "Thinking off",
      }),
    ).toBe(withoutGoalWidth + 3 + "Goal coord".length);
  });
});
