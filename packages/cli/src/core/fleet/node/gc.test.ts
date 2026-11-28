import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startGcSweeper, sweepNode } from "./gc.js";
import { tempDir } from "./__fixtures__/server.js";

const DAY = 86_400_000;

function file(p: string, bytes: number, mtime: number) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes));
  fs.utimesSync(p, mtime / 1000, mtime / 1000);
}

describe("node gc", () => {
  it("removes finished jobs older than gcDays and never busy ones", () => {
    const dir = tempDir();
    const now = Date.parse("2026-11-27T12:00:00Z");
    const old = now - 10 * DAY;
    for (const id of ["old", "busy", "fresh"]) {
      file(path.join(dir, "jobs", id, "src.txt"), 10, id === "fresh" ? now - DAY : old);
      file(path.join(dir, "run", id, "output.log"), 10, id === "fresh" ? now - DAY : old);
      file(path.join(dir, "artifacts", id, "a.bin"), 10, id === "fresh" ? now - DAY : old);
    }
    const r = sweepNode({
      dataDir: dir,
      now: () => now,
      jobBusy: (id) => id === "busy",
      cacheBusy: () => false,
    });
    expect(r.jobs).toEqual(["old"]);
    expect(fs.existsSync(path.join(dir, "run", "old"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "artifacts", "old"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "run", "busy"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "jobs", "fresh"))).toBe(true);
    // finishedAt from the caller wins over mtimes; gcDays is read live.
    const r2 = sweepNode({
      dataDir: dir,
      now: () => now,
      gcDays: () => 0.5,
      jobBusy: () => false,
      cacheBusy: () => false,
      finishedAt: (id) => (id === "busy" ? now - 60_000 : undefined),
    });
    expect(r2.jobs).toEqual(["fresh"]);
  });

  it("trims caches over the cap, least recently used first, skipping busy ones", () => {
    const dir = tempDir();
    const now = Date.now();
    const MB = 1024 ** 2;
    file(path.join(dir, "cache", "oldest", "f"), 2 * MB, now - 5 * DAY);
    file(path.join(dir, "cache", "busy", "f"), 2 * MB, now - 4 * DAY);
    file(path.join(dir, "cache", "middle", "f"), 2 * MB, now - 3 * DAY);
    file(path.join(dir, "cache", "newest", "f"), 2 * MB, now - DAY);
    const r = sweepNode({
      dataDir: dir,
      now: () => now,
      cacheCapGb: () => (4.5 * MB) / 1024 ** 3,
      jobBusy: () => false,
      cacheBusy: (n) => n === "busy",
    });
    expect(r.caches).toEqual(["oldest", "middle"]);
    expect(fs.readdirSync(path.join(dir, "cache")).sort()).toEqual(["busy", "newest"]);
  });

  it("sweeps on its timer and stops", () => {
    const dir = tempDir();
    let tick: (() => void) | undefined;
    let cleared = false;
    let now = 0;
    file(path.join(dir, "run", "j1", "output.log"), 1, 1000);
    const gc = startGcSweeper({
      dataDir: dir,
      now: () => now,
      jobBusy: () => false,
      cacheBusy: () => false,
      intervalMs: 1000,
      setInterval: (fn) => {
        tick = fn;
        return 1;
      },
      clearInterval: () => {
        cleared = true;
      },
    });
    tick!();
    expect(fs.existsSync(path.join(dir, "run", "j1"))).toBe(true);
    now = 8 * DAY + 1000;
    tick!();
    expect(fs.existsSync(path.join(dir, "run", "j1"))).toBe(false);
    gc.stop();
    expect(cleared).toBe(true);
  });
});
