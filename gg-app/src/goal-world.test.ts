import { describe, expect, it } from "vitest";
import type { FloorAgent } from "./critter-floor";
import {
  COORDINATOR_KEY,
  collectWorldAgents,
  coordinatorKind,
  type WorldAgent,
} from "./goal-world-agents";
import { STATION_FOR, STATION_KINDS } from "./goal-world-stations";
import { FARM_CORE, buildFarm, type Farm, type Rect } from "./goal-farm-map";
import {
  ARRIVE_MS,
  LEAVE_MS,
  MIN_WORK_MS,
  createFarmWorld,
  resizeFarm,
  spotAt,
  stepFarm,
  syncFarm,
} from "./goal-farm-sim";
import {
  MAX_TRIP_MS,
  TRAVEL_MODES,
  chooseMode,
  createRouter,
  pathLength,
  planTrip,
  tripPose,
} from "./goal-farm-travel";
import { TILE } from "./goal-map-ground";

const farm = buildFarm();

/** A fixed sequence of draws, so the farm replays the same way every run. */
function draws(...values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length] ?? 0;
}

const worker = (over: Partial<FloorAgent> = {}): FloorAgent => ({
  key: "g1:t1",
  agentName: "researcher",
  label: "Researcher",
  status: "running",
  activity: "Reading src/app.ts",
  tokens: "",
  durationMs: 0,
  toolUseCount: 1,
  ...over,
});

const coordinatorAgent = (over: Partial<WorldAgent> = {}): WorldAgent => ({
  key: COORDINATOR_KEY,
  agentName: undefined,
  name: "GG Goals",
  coordinator: true,
  status: "working",
  kind: "think",
  detail: "Planning",
  ...over,
});

const inside = (r: Rect, x: number, y: number): boolean =>
  x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h;

/** Does the segment from a to b pass through any obstacle? (Sampled every 2px.) */
function crosses(f: Farm, a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2));
  for (let i = 0; i <= steps; i++) {
    const x = a.x + ((b.x - a.x) * i) / steps;
    const y = a.y + ((b.y - a.y) * i) / steps;
    if (f.obstacles.some((r) => inside(r, x, y))) return true;
  }
  return false;
}

describe("goal world agents", () => {
  it("puts GG Goals first and reads its work from the live tool feed", () => {
    const agents = collectWorldAgents({
      running: true,
      waitingOnUser: false,
      liveTools: [
        { id: "a", name: "read", args: { file_path: "/x/a.ts" }, status: "done" },
        { id: "b", name: "web_search", args: { query: "seo 2026" }, status: "running" },
      ] as never,
      workers: [worker()],
    });
    expect(agents.map((a) => a.key)).toEqual([COORDINATOR_KEY, "g1:t1"]);
    expect(agents[0]).toMatchObject({ kind: "web", detail: "Browsing seo 2026" });
    expect(agents[1]).toMatchObject({ kind: "read", status: "working" });
  });

  it("shows GG Goals at the mailbox while it waits on the user, and resting when idle", () => {
    const base = { liveTools: [], workers: [] };
    expect(collectWorldAgents({ ...base, running: true, waitingOnUser: true })[0]?.kind).toBe(
      "ask",
    );
    expect(collectWorldAgents({ ...base, running: false, waitingOnUser: false })[0]).toMatchObject({
      status: "idle",
      kind: null,
    });
  });

  it("maps orchestration tools to orchestration work", () => {
    expect(coordinatorKind("spawn_agent")).toBe("delegate");
    expect(coordinatorKind("wait_agent")).toBe("wait");
    expect(coordinatorKind("ask_user")).toBe("ask");
    expect(coordinatorKind("edit")).toBe("edit");
    expect(coordinatorKind("some_mcp_tool")).toBe("think");
  });

  it("marks finished and failed workers so they leave", () => {
    const agents = collectWorldAgents({
      running: false,
      waitingOnUser: false,
      liveTools: [],
      workers: [worker({ status: "done" }), worker({ key: "g1:t2", status: "error" })],
    });
    expect(agents.slice(1).map((a) => [a.status, a.kind])).toEqual([
      ["done", null],
      ["error", null],
    ]);
  });
});

describe("goal farm map", () => {
  it("has a place for every kind of work, inside the map and clear of the buildings", () => {
    for (const kind of STATION_KINDS) {
      const spots = farm.stations[kind];
      expect(spots.length).toBeGreaterThan(0);
      for (const spot of spots) {
        expect(spot.x).toBeGreaterThan(0);
        expect(spot.y).toBeGreaterThan(0);
        expect(spot.x).toBeLessThan(farm.width);
        expect(spot.y).toBeLessThan(farm.height);
        expect(farm.obstacles.some((r) => inside(r, spot.x, spot.y))).toBe(false);
      }
    }
    for (const station of Object.values(STATION_FOR)) {
      expect(farm.stations[station].length).toBeGreaterThan(0);
    }
  });

  it("lays its walkways around the house, the pond, the trees and the fields", () => {
    for (const [a, b] of farm.paths.edges) {
      const na = farm.paths.nodes[a];
      const nb = farm.paths.nodes[b];
      if (!na || !nb) throw new Error(`edge ${a}-${b} has a missing node`);
      expect(crosses(farm, na, nb), `walkway ${a}-${b}`).toBe(false);
    }
  });

  it("joins every place to every other, so nobody gets stuck", () => {
    const router = createRouter(farm.paths);
    const spots = STATION_KINDS.map((kind) => farm.stations[kind][0]).filter(
      (s) => s !== undefined,
    );
    for (const from of spots) {
      for (const to of spots) {
        const route = router.route(from, to);
        expect(route[0]).toEqual(from);
        expect(route[route.length - 1]).toEqual(to);
      }
    }
  });

  it("keeps the farmstead whole, centred below the header, on any bigger map", () => {
    const big = buildFarm({ cols: 44, rows: 28, top: 3 });
    expect([big.width, big.height]).toEqual([44 * TILE, 28 * TILE]);
    expect(big.origin.x).toBe(Math.floor((44 - FARM_CORE.cols) / 2) * TILE);
    expect(big.origin.y).toBeGreaterThanOrEqual(3 * TILE);
    expect(big.origin.y + FARM_CORE.rows * TILE).toBeLessThanOrEqual(big.height);
    // Everything about the farmstead moved with it.
    const shift = { x: big.origin.x - farm.origin.x, y: big.origin.y - farm.origin.y };
    const gate = farm.stations.door[0];
    expect(big.stations.door[0]).toEqual(gate && { x: gate.x + shift.x, y: gate.y + shift.y });
    // A map smaller than the farmstead is grown to fit it.
    const tiny = buildFarm({ cols: 10, rows: 8 });
    expect([tiny.width, tiny.height]).toEqual([FARM_CORE.cols * TILE, FARM_CORE.rows * TILE]);
  });
});

describe("goal farm travel", () => {
  it("never plans a trip longer than the cap, whatever the draw", () => {
    const router = createRouter(farm.paths);
    const spots = STATION_KINDS.map((kind) => farm.stations[kind][0]).filter(
      (s) => s !== undefined,
    );
    for (const from of spots) {
      for (const to of spots) {
        for (const roll of [0, 0.3, 0.6, 0.9]) {
          for (const hurry of [false, true]) {
            const trip = planTrip(router.route(from, to), { hurry, roll, now: 0 });
            expect(TRAVEL_MODES).toContain(trip.mode);
            expect(trip.duration).toBeLessThanOrEqual(MAX_TRIP_MS);
          }
        }
      }
    }
  });

  it("walks short hops and rides or flies long ones", () => {
    expect(chooseMode(20, true, 0.9)).toBe("walk");
    expect(["skate", "run"]).toContain(chooseMode(70, true, 0.2));
    expect(["jetpack", "teleport"]).toContain(chooseMode(300, true, 0.2));
  });

  it("ends every trip exactly where it was headed, back on the ground", () => {
    const router = createRouter(farm.paths);
    const from = farm.stations.door[0] ?? farm.origin;
    const to = farm.stations.machine[0] ?? farm.origin;
    for (const roll of [0, 0.5, 0.7, 0.95]) {
      const trip = planTrip(router.route(from, to), { hurry: false, roll, now: 1000 });
      const end = tripPose(trip, 1000 + trip.duration);
      expect(end.done).toBe(true);
      expect([Math.round(end.x), Math.round(end.y)]).toEqual([to.x, to.y]);
      expect(end.lift).toBe(0);
      expect(end.alpha).toBe(1);
    }
  });

  it("follows the walkways instead of cutting across the yard", () => {
    const router = createRouter(farm.paths);
    const route = router.route(
      farm.stations.door[0] ?? farm.origin,
      farm.stations.workbench[0] ?? farm.origin,
    );
    expect(route.length).toBeGreaterThan(3);
    for (let i = 2; i < route.length - 1; i++) {
      const a = route[i - 1];
      const b = route[i];
      if (a && b) expect(crosses(farm, a, b)).toBe(false);
    }
    expect(pathLength(route)).toBeGreaterThan(0);
  });
});

describe("goal farm life", () => {
  it("places agents already at work on the first sync instead of walking them in", () => {
    const world = createFarmWorld(farm, draws(0.5));
    syncFarm(
      world,
      [coordinatorAgent(), { ...coordinatorAgent(), key: "w", coordinator: false, kind: "read" }],
      0,
    );
    const placed = world.actors.get("w");
    expect(placed?.state).toBe("working");
    expect(placed?.station).toBe("bookcase");
    expect(placed?.spot).toEqual(farm.stations.bookcase[0]);
    expect(world.actors.get(COORDINATOR_KEY)?.critterId).toBe("fox");
  });

  it("walks a new worker in through the gate, to its station, and out again when done", () => {
    const world = createFarmWorld(farm, draws(0.1, 0.7, 0.4));
    syncFarm(world, [coordinatorAgent({ kind: "delegate" })], 0);
    const newcomer: WorldAgent = {
      key: "w1",
      agentName: "worker",
      name: "Worker",
      coordinator: false,
      status: "working",
      kind: "edit",
      detail: "Editing",
    };
    syncFarm(world, [coordinatorAgent(), newcomer], 100);
    const actor = world.actors.get("w1");
    expect(actor?.state).toBe("arriving");
    expect(actor?.station).toBe("door");
    expect(actor?.bubble?.text).toBe("Hi!");

    // Steps in, travels, and gets to work at the carpenter's bench.
    let now = 100;
    for (; now < 100 + ARRIVE_MS + MAX_TRIP_MS + 200; now += 16) stepFarm(world, now);
    expect(actor?.station).toBe("workbench");
    expect(actor?.state).toBe("working");

    // Finished: back to the gate, says goodbye, and is gone.
    syncFarm(world, [coordinatorAgent(), { ...newcomer, status: "done", kind: null }], now);
    for (const end = now + MIN_WORK_MS + MAX_TRIP_MS + LEAVE_MS + 400; now < end; now += 16) {
      stepFarm(world, now);
    }
    expect(world.actors.has("w1")).toBe(false);
    expect(world.actors.has(COORDINATOR_KEY)).toBe(true);
  });

  it("stays at a station long enough to be seen working before moving on", () => {
    const world = createFarmWorld(farm, draws(0.5));
    const agent = { ...coordinatorAgent(), key: "w", coordinator: false, kind: "read" as const };
    syncFarm(world, [coordinatorAgent(), agent], 0);
    syncFarm(world, [coordinatorAgent(), { ...agent, kind: "edit" }], 10);
    stepFarm(world, 20);
    expect(world.actors.get("w")?.station).toBe("bookcase");
    stepFarm(world, MIN_WORK_MS + 50);
    expect(world.actors.get("w")?.station).toBe("workbench");
  });

  it("jumps straight to the end state when motion is off", () => {
    const world = createFarmWorld(farm, draws(0.5));
    syncFarm(world, [coordinatorAgent({ kind: "web" })], 0);
    syncFarm(world, [coordinatorAgent({ kind: "read" })], 5);
    stepFarm(world, 10, true);
    const coordinator = world.actors.get(COORDINATOR_KEY);
    expect(coordinator?.trip).toBeNull();
    expect(coordinator?.station).toBe("bookcase");
    expect(coordinator?.spot).toEqual(farm.stations.bookcase[0]);
    expect(coordinator?.state).toBe("working");
  });

  it("gives crowded stations a place for everyone", () => {
    const seen = new Set<string>();
    for (let slot = 0; slot < 12; slot++) {
      const spot = spotAt(farm, "lounge", slot);
      seen.add(`${spot.x},${spot.y}`);
    }
    expect(seen.size).toBe(12);
  });

  it("keeps everyone at their stations through a resize, wherever the farmstead moves", () => {
    const world = createFarmWorld(farm, draws(0.5));
    syncFarm(world, [coordinatorAgent({ kind: "read" })], 0);
    const bigger = buildFarm({ cols: 40, rows: 26 });
    resizeFarm(world, bigger);
    const coordinator = world.actors.get(COORDINATOR_KEY);
    expect(coordinator?.spot).toEqual(bigger.stations.bookcase[0]);
    expect(coordinator?.trip).toBeNull();
  });
});
