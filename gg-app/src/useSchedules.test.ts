// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TICK_MS, useSchedules } from "./useSchedules";
import type { ParsedSchedule } from "./scheduleCommand";

const MIN = 60_000;

function parsed(over: Partial<ParsedSchedule> = {}): ParsedSchedule {
  return { prompt: "check the railway logs", intervalMs: 15 * MIN, runCount: null, ...over };
}

/** Advance the fake clock inside act(), so the ticker's state lands. */
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useSchedules", () => {
  it("does not fire before the first interval elapses", () => {
    const onFire = vi.fn();
    const { result } = renderHook(() => useSchedules({ running: false, onFire }));
    act(() => {
      result.current.addSchedule(parsed());
    });

    advance(15 * MIN - 1000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("fires at the interval", () => {
    const onFire = vi.fn();
    const { result } = renderHook(() => useSchedules({ running: false, onFire }));
    act(() => {
      result.current.addSchedule(parsed());
    });

    advance(15 * MIN);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledWith("check the railway logs");
  });

  it("keeps firing on cadence when the count is null", () => {
    const onFire = vi.fn();
    const { result } = renderHook(() => useSchedules({ running: false, onFire }));
    act(() => {
      result.current.addSchedule(parsed());
    });

    advance(15 * MIN);
    expect(onFire).toHaveBeenCalledTimes(1);
    advance(15 * MIN);
    expect(onFire).toHaveBeenCalledTimes(2);
    advance(15 * MIN);
    expect(onFire).toHaveBeenCalledTimes(3);
    // Still listed: an open-ended schedule never retires itself.
    expect(result.current.schedules).toHaveLength(1);
  });

  it("counts completed runs", () => {
    const onFire = vi.fn();
    const { result } = renderHook(() => useSchedules({ running: false, onFire }));
    act(() => {
      result.current.addSchedule(parsed());
    });

    advance(15 * MIN);
    expect(result.current.schedules[0]?.runsCompleted).toBe(1);
    advance(15 * MIN);
    expect(result.current.schedules[0]?.runsCompleted).toBe(2);
  });

  it("stops at runCount and drops off the list", () => {
    const onFire = vi.fn();
    const { result } = renderHook(() => useSchedules({ running: false, onFire }));
    act(() => {
      result.current.addSchedule(parsed({ runCount: 3 }));
    });

    advance(15 * MIN);
    advance(15 * MIN);
    expect(onFire).toHaveBeenCalledTimes(2);
    expect(result.current.schedules).toHaveLength(1);

    advance(15 * MIN);
    expect(onFire).toHaveBeenCalledTimes(3);
    expect(result.current.schedules).toHaveLength(0);

    // Well past the next boundary: a retired schedule must not fire again.
    advance(60 * MIN);
    expect(onFire).toHaveBeenCalledTimes(3);
  });

  it("fires exactly once for a count of 1", () => {
    const onFire = vi.fn();
    const { result } = renderHook(() => useSchedules({ running: false, onFire }));
    act(() => {
      result.current.addSchedule(parsed({ runCount: 1 }));
    });

    advance(15 * MIN);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(result.current.schedules).toHaveLength(0);
  });

  describe("no overlap while a run is in flight", () => {
    it("skips the occurrence instead of stacking", () => {
      const onFire = vi.fn();
      const { result, rerender } = renderHook(({ running }) => useSchedules({ running, onFire }), {
        initialProps: { running: false },
      });
      act(() => {
        result.current.addSchedule(parsed());
      });

      rerender({ running: true });
      advance(15 * MIN);
      expect(onFire).not.toHaveBeenCalled();
      // Nothing ran, so the completed count must not move.
      expect(result.current.schedules[0]?.runsCompleted).toBe(0);
    });

    it("resumes at the next boundary once the run finishes", () => {
      const onFire = vi.fn();
      const { result, rerender } = renderHook(({ running }) => useSchedules({ running, onFire }), {
        initialProps: { running: false },
      });
      act(() => {
        result.current.addSchedule(parsed());
      });

      rerender({ running: true });
      advance(15 * MIN);
      expect(onFire).not.toHaveBeenCalled();

      // Run ends; the skipped occurrence is NOT replayed immediately.
      rerender({ running: false });
      advance(1000);
      expect(onFire).not.toHaveBeenCalled();

      // It fires at the next scheduled boundary instead.
      advance(15 * MIN);
      expect(onFire).toHaveBeenCalledTimes(1);
    });

    it("does not accumulate a backlog across several missed occurrences", () => {
      const onFire = vi.fn();
      const { result, rerender } = renderHook(({ running }) => useSchedules({ running, onFire }), {
        initialProps: { running: false },
      });
      act(() => {
        result.current.addSchedule(parsed());
      });

      // A long run swallows three whole occurrences.
      rerender({ running: true });
      advance(45 * MIN);
      expect(onFire).not.toHaveBeenCalled();

      rerender({ running: false });
      advance(15 * MIN);
      // Exactly one run, not the three that were missed.
      expect(onFire).toHaveBeenCalledTimes(1);
    });
  });

  it("fires at most one schedule per tick", () => {
    // runningRef cannot flip mid-loop (the run it describes starts
    // asynchronously), so without an explicit guard two schedules coming due in
    // the same tick would both fire and start concurrent agents.
    const onFire = vi.fn();
    const { result } = renderHook(() => useSchedules({ running: false, onFire }));
    act(() => {
      result.current.addSchedule(parsed({ prompt: "one", intervalMs: 15 * MIN }));
      result.current.addSchedule(parsed({ prompt: "two", intervalMs: 15 * MIN }));
    });

    advance(15 * MIN);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledWith("one");

    // The deferred one fires on the very NEXT tick, not a whole interval later
    // — and crucially it is not starved by a peer sharing its cadence.
    advance(TICK_MS);
    expect(onFire).toHaveBeenCalledTimes(2);
    expect(onFire).toHaveBeenLastCalledWith("two");
  });

  it("does not advance runsCompleted for a schedule skipped by another", () => {
    const onFire = vi.fn();
    const { result } = renderHook(() => useSchedules({ running: false, onFire }));
    act(() => {
      result.current.addSchedule(parsed({ prompt: "one", intervalMs: 15 * MIN }));
      result.current.addSchedule(parsed({ prompt: "two", intervalMs: 15 * MIN }));
    });

    advance(15 * MIN);
    const two = result.current.schedules.find((s) => s.prompt === "two");
    expect(two?.runsCompleted).toBe(0);
  });

  it("does not starve a schedule that shares a cadence with another", () => {
    const onFire = vi.fn();
    const { result } = renderHook(() => useSchedules({ running: false, onFire }));
    act(() => {
      result.current.addSchedule(parsed({ prompt: "one", intervalMs: 15 * MIN }));
      result.current.addSchedule(parsed({ prompt: "two", intervalMs: 15 * MIN }));
    });

    // Over several shared boundaries both must make progress, rather than the
    // first in the list winning every tick forever. The extra tick lets the
    // deferred schedule take its turn after the final shared boundary.
    advance(45 * MIN);
    advance(TICK_MS);
    const prompts = onFire.mock.calls.map((c) => c[0]);
    expect(prompts.filter((p) => p === "one").length).toBeGreaterThanOrEqual(3);
    expect(prompts.filter((p) => p === "two").length).toBeGreaterThanOrEqual(3);
  });

  describe("stopping", () => {
    it("cancels a schedule so it never fires again", () => {
      const onFire = vi.fn();
      const { result } = renderHook(() => useSchedules({ running: false, onFire }));
      let id = "";
      act(() => {
        id = result.current.addSchedule(parsed());
      });

      advance(15 * MIN);
      expect(onFire).toHaveBeenCalledTimes(1);

      act(() => {
        result.current.stopSchedule(id);
      });
      expect(result.current.schedules).toHaveLength(0);

      advance(60 * MIN);
      expect(onFire).toHaveBeenCalledTimes(1);
    });

    it("leaves other schedules running", () => {
      const onFire = vi.fn();
      const { result } = renderHook(() => useSchedules({ running: false, onFire }));
      let first = "";
      act(() => {
        first = result.current.addSchedule(parsed({ prompt: "one" }));
        result.current.addSchedule(parsed({ prompt: "two", intervalMs: 30 * MIN }));
      });
      expect(result.current.schedules).toHaveLength(2);

      act(() => {
        result.current.stopSchedule(first);
      });

      advance(30 * MIN);
      expect(onFire).toHaveBeenCalledTimes(1);
      expect(onFire).toHaveBeenCalledWith("two");
    });
  });

  describe("multiple schedules", () => {
    it("fires each on its own cadence", () => {
      const onFire = vi.fn();
      const { result } = renderHook(() => useSchedules({ running: false, onFire }));
      act(() => {
        result.current.addSchedule(parsed({ prompt: "fast", intervalMs: 15 * MIN }));
        result.current.addSchedule(parsed({ prompt: "slow", intervalMs: 60 * MIN }));
      });

      advance(15 * MIN);
      expect(onFire.mock.calls.map((c) => c[0])).toEqual(["fast"]);

      advance(45 * MIN);
      // At t=60m both come due; fast claims the tick and slow is deferred by
      // one tick rather than losing its turn.
      advance(TICK_MS);
      // fast ran at 30, 45 and 60; slow ran once just after 60.
      const prompts = onFire.mock.calls.map((c) => c[0]);
      expect(prompts.filter((p) => p === "fast")).toHaveLength(4);
      expect(prompts.filter((p) => p === "slow")).toHaveLength(1);
    });
  });

  it("clears its ticker on unmount", () => {
    const onFire = vi.fn();
    const { result, unmount } = renderHook(() => useSchedules({ running: false, onFire }));
    act(() => {
      result.current.addSchedule(parsed());
    });

    unmount();
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(60 * MIN);
    expect(onFire).not.toHaveBeenCalled();
  });
});
