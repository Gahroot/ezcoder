import { useCallback, useEffect, useRef, useState } from "react";
import type { ActiveSchedule } from "./RunningSchedulesButton";
import type { ParsedSchedule } from "./scheduleCommand";

/**
 * Runtime for `/schedule`: owns the active schedules and fires their prompts.
 *
 * ## Why one ticker rather than a timer per schedule
 *
 * A single 1s interval compares every schedule's `nextRunAt` against the clock.
 * Per-schedule `setTimeout`s would drift, need individual cleanup, and — the
 * real problem — silently die if the machine sleeps through their deadline. A
 * polled comparison recovers from sleep on its own, because it re-reads the
 * clock rather than trusting a timer that was never scheduled to survive.
 *
 * ## Missed occurrences are skipped, never replayed
 *
 * If several intervals elapsed while the app was busy or asleep, `nextRunAt`
 * advances to the next FUTURE boundary instead of firing once per missed slot.
 * A monitoring prompt that fell four occurrences behind should check the logs
 * once, now — not launch four agents against a repo that has moved on.
 *
 * ## Never stack runs
 *
 * A due schedule whose turn arrives while the agent is mid-run is skipped and
 * re-aimed at the next boundary; `runsCompleted` does not advance, because
 * nothing ran. Queueing it instead would let a 20-minute turn accumulate a
 * backlog of 15-minute schedules and then fire them back-to-back, with several
 * agents editing the same files.
 *
 * ## Lifetime
 *
 * Schedules live in memory for the life of the window. Closing the window (or
 * quitting the app) drops them — there is no persistence and no background
 * service, so a schedule only fires while GG Coder is open. The footer pill
 * states this so the guarantee is visible where the schedules are.
 */

/** How often the ticker re-checks for due schedules. */
export const TICK_MS = 1000;

export interface Schedules {
  schedules: readonly ActiveSchedule[];
  /** Register a parsed `/schedule` command. Returns the new schedule's id. */
  addSchedule: (parsed: ParsedSchedule) => string;
  /** Cancel a schedule by id. */
  stopSchedule: (id: string) => void;
}

/**
 * Next boundary strictly in the future, skipping any occurrences missed while
 * the app was busy or asleep.
 */
function advanceNextRun(nextRunAt: number, intervalMs: number, now: number): number {
  if (now < nextRunAt) return nextRunAt;
  const missed = Math.floor((now - nextRunAt) / intervalMs) + 1;
  return nextRunAt + missed * intervalMs;
}

let idCounter = 0;

export function useSchedules(opts: {
  /** True while the agent is mid-run; due schedules are skipped rather than stacked. */
  running: boolean;
  /** Sends one scheduled prompt through the normal send path. */
  onFire: (prompt: string) => void;
}): Schedules {
  const { running, onFire } = opts;
  const [schedules, setSchedules] = useState<readonly ActiveSchedule[]>([]);

  // The ref is authoritative for the ticker; `schedules` mirrors it for render.
  // Deriving fires from a `setState` updater instead would run side effects
  // during the render phase, and double-fire under StrictMode's double
  // invocation.
  const schedulesRef = useRef<readonly ActiveSchedule[]>([]);
  const runningRef = useRef(running);
  const onFireRef = useRef(onFire);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);
  useEffect(() => {
    onFireRef.current = onFire;
  }, [onFire]);

  const commit = useCallback((next: readonly ActiveSchedule[]) => {
    schedulesRef.current = next;
    setSchedules(next);
  }, []);

  const addSchedule = useCallback(
    (parsed: ParsedSchedule): string => {
      idCounter += 1;
      const id = `sch-${idCounter}`;
      // The first run lands one full interval out. Firing instantly on submit
      // would start an agent the moment the user pressed Enter, which is not
      // what "every 15m" asks for and is a surprising thing for a command that
      // reads as future-tense.
      const schedule: ActiveSchedule = {
        ...parsed,
        id,
        nextRunAt: Date.now() + parsed.intervalMs,
        runsCompleted: 0,
      };
      commit([...schedulesRef.current, schedule]);
      return id;
    },
    [commit],
  );

  const stopSchedule = useCallback(
    (id: string) => {
      commit(schedulesRef.current.filter((s) => s.id !== id));
    },
    [commit],
  );

  useEffect(() => {
    const tick = (): void => {
      const current = schedulesRef.current;
      if (current.length === 0) return;

      const now = Date.now();
      const next: ActiveSchedule[] = [];
      let toFire: string | null = null;
      let changed = false;

      for (const schedule of current) {
        if (now < schedule.nextRunAt) {
          next.push(schedule);
          continue;
        }
        changed = true;

        // A run is already in flight: skip this occurrence entirely and re-aim
        // at the next boundary. runsCompleted is untouched because nothing ran.
        if (runningRef.current) {
          next.push({
            ...schedule,
            nextRunAt: advanceNextRun(schedule.nextRunAt, schedule.intervalMs, now),
          });
          continue;
        }

        // Another schedule already claimed this tick. `runningRef` cannot flip
        // mid-loop — the run it describes starts asynchronously — so firing both
        // would start concurrent agents on the same repo, exactly what the
        // no-stacking rule exists to prevent.
        //
        // Leave `nextRunAt` in the past rather than advancing it, so this one
        // fires on the NEXT tick (a second later) instead of losing its turn.
        // Advancing here would starve it forever when two schedules share a
        // cadence: both would come due together every time and the first in the
        // list would always win.
        if (toFire !== null) {
          next.push(schedule);
          continue;
        }

        toFire = schedule.prompt;
        const runsCompleted = schedule.runsCompleted + 1;
        // Bounded schedule that has run its course drops off the list; a null
        // runCount runs until stopped.
        if (schedule.runCount !== null && runsCompleted >= schedule.runCount) continue;
        next.push({
          ...schedule,
          runsCompleted,
          nextRunAt: advanceNextRun(schedule.nextRunAt, schedule.intervalMs, now),
        });
      }

      if (changed) commit(next);
      // Fire AFTER committing, so a prompt that synchronously flips `running`
      // sees the already-updated schedule list.
      if (toFire !== null) onFireRef.current(toFire);
    };

    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  }, [commit]);

  return { schedules, addSchedule, stopSchedule };
}
