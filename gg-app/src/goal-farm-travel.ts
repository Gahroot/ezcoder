// How a critter gets around the farm. Walking follows the yard's paths, a
// small waypoint graph laid out to keep clear of the house, the pond and the
// beds. Agents switch work in a blink, so long trips don't just play faster:
// a critter rides a skateboard or a motorbike along the paths, flies straight
// over on a jetpack, or teleports. Pure: a trip is planned once, and its pose
// can be read at any moment.

export const TRAVEL_MODES = ["walk", "run", "skate", "bike", "jetpack", "teleport"] as const;
export type TravelMode = (typeof TRAVEL_MODES)[number];

/** A point on the map, in map pixels (for a critter: where its feet are). */
export interface Spot {
  readonly x: number;
  readonly y: number;
}

/** The yard's walkways: points, and which pairs are joined by a clear path. */
export interface PathGraph {
  readonly nodes: readonly Spot[];
  readonly edges: ReadonlyArray<readonly [number, number]>;
}

export interface Trip {
  readonly mode: TravelMode;
  readonly from: Spot;
  readonly to: Spot;
  /** The route it follows (ground modes), or just its two ends (flying, teleporting). */
  readonly path: readonly Spot[];
  readonly start: number;
  readonly duration: number;
}

export interface Pose {
  readonly x: number;
  /** Where its feet (and its shadow) are on the ground. */
  readonly y: number;
  /** How far above the ground it is drawn (a jetpack's arc). */
  readonly lift: number;
  readonly facing: 1 | -1;
  readonly alpha: number;
  readonly done: boolean;
}

/** No trip takes longer than this; slower ways of travelling get upgraded. */
export const MAX_TRIP_MS = 1500;
const TELEPORT_MS = 520;
/** Two spots this close are joined directly, without the paths. */
const DIRECT = 26;
/** Map pixels per second, for the ways that follow the paths. */
const SPEED: Readonly<Record<"walk" | "run" | "skate" | "bike", number>> = {
  walk: 42,
  run: 88,
  skate: 150,
  bike: 205,
};

const dist = (a: Spot, b: Spot): number => Math.hypot(b.x - a.x, b.y - a.y);

export function pathLength(path: readonly Spot[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    if (a && b) total += dist(a, b);
  }
  return total;
}

export interface Router {
  /** The walking route from one spot to another, via the yard's paths. */
  route(from: Spot, to: Spot): Spot[];
}

/** Precompute every shortest route through the graph (it is small). */
export function createRouter(graph: PathGraph): Router {
  const n = graph.nodes.length;
  const d: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : Infinity)),
  );
  const next: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? j : -1)),
  );
  for (const [a, b] of graph.edges) {
    const na = graph.nodes[a];
    const nb = graph.nodes[b];
    if (!na || !nb) continue;
    const len = dist(na, nb);
    const rowA = d[a];
    const rowB = d[b];
    if (rowA && rowB) {
      rowA[b] = len;
      rowB[a] = len;
    }
    const nextA = next[a];
    const nextB = next[b];
    if (nextA && nextB) {
      nextA[b] = b;
      nextB[a] = a;
    }
  }
  // Floyd–Warshall, with next hops so routes can be read back.
  for (let k = 0; k < n; k++) {
    const rowK = d[k];
    if (!rowK) continue;
    for (let i = 0; i < n; i++) {
      const rowI = d[i];
      const nextI = next[i];
      if (!rowI || !nextI) continue;
      const ik = rowI[k] ?? Infinity;
      if (ik === Infinity) continue;
      for (let j = 0; j < n; j++) {
        const through = ik + (rowK[j] ?? Infinity);
        if (through < (rowI[j] ?? Infinity)) {
          rowI[j] = through;
          nextI[j] = nextI[k] ?? -1;
        }
      }
    }
  }
  const nearest = (p: Spot): number => {
    let best = 0;
    let bestD = Infinity;
    graph.nodes.forEach((node, i) => {
      const dd = dist(p, node);
      if (dd < bestD) {
        bestD = dd;
        best = i;
      }
    });
    return best;
  };
  return {
    route(from, to) {
      if (dist(from, to) <= DIRECT || n === 0) return [from, to];
      const a = nearest(from);
      const b = nearest(to);
      const hops: Spot[] = [];
      let at = a;
      for (let guard = 0; guard <= n; guard++) {
        const node = graph.nodes[at];
        if (node) hops.push(node);
        if (at === b) break;
        const step = next[at]?.[b] ?? -1;
        if (step < 0) break;
        at = step;
      }
      const path = [from, ...hops, to];
      // Drop repeated points (a spot standing right on a node).
      return path.filter((p, i) => {
        const prev = path[i - 1];
        return i === 0 || !prev || dist(prev, p) > 0.5;
      });
    },
  };
}

function groundMs(mode: keyof typeof SPEED, length: number): number {
  return Math.round((length / SPEED[mode]) * 1000);
}

function flightMs(from: Spot, to: Spot): number {
  return Math.round(Math.min(1100, Math.max(520, 400 + dist(from, to) * 2.2)));
}

/**
 * Choose how to travel a route. `roll` is a 0–1 draw (seeded by the caller,
 * so a critter's choices replay the same way). Hurried critters (ones whose
 * work keeps changing) favour the fast ways.
 */
export function chooseMode(length: number, hurry: boolean, roll: number): TravelMode {
  let mode: TravelMode;
  if (length <= 30) mode = "walk";
  else if (length <= 90) mode = hurry && roll < 0.5 ? "skate" : "run";
  else if (length > 240 && hurry) mode = roll < 0.5 ? "jetpack" : "teleport";
  else if (roll < 0.34) mode = "skate";
  else if (roll < 0.64) mode = "bike";
  else if (roll < 0.86) mode = "jetpack";
  else mode = "teleport";
  // Never let a trip drag: upgrade anything too slow for the distance.
  if ((mode === "walk" || mode === "run") && groundMs(mode, length) > MAX_TRIP_MS) mode = "bike";
  if ((mode === "skate" || mode === "bike") && groundMs(mode, length) > MAX_TRIP_MS) {
    mode = "jetpack";
  }
  return mode;
}

/** Plan a trip along a route, choosing how to travel it. */
export function planTrip(
  route: readonly Spot[],
  options: { readonly hurry: boolean; readonly roll: number; readonly now: number },
): Trip {
  const from = route[0] ?? { x: 0, y: 0 };
  const to = route[route.length - 1] ?? from;
  const length = pathLength(route);
  const mode = chooseMode(length, options.hurry, options.roll);
  const flying = mode === "jetpack" || mode === "teleport";
  const path = flying ? [from, to] : route;
  const duration =
    mode === "teleport"
      ? TELEPORT_MS
      : mode === "jetpack"
        ? flightMs(from, to)
        : Math.max(160, groundMs(mode, length));
  return { mode, from, to, path, start: options.now, duration };
}

const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

function along(path: readonly Spot[], distance: number): { at: Spot; dx: number } {
  let left = distance;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    if (!a || !b) continue;
    const seg = dist(a, b);
    if (left <= seg || i === path.length - 1) {
      const t = seg === 0 ? 1 : Math.min(1, left / seg);
      return { at: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, dx: b.x - a.x };
    }
    left -= seg;
  }
  return { at: path[path.length - 1] ?? { x: 0, y: 0 }, dx: 0 };
}

/** Where a trip has the critter at `now`. */
export function tripPose(trip: Trip, now: number, lastFacing: 1 | -1 = 1): Pose {
  const t = trip.duration <= 0 ? 1 : Math.min(1, Math.max(0, (now - trip.start) / trip.duration));
  const done = t >= 1;
  const { from, to } = trip;
  const heading = (dx: number): 1 | -1 => (dx > 0.5 ? 1 : dx < -0.5 ? -1 : lastFacing);

  if (trip.mode === "teleport") {
    // Fade out where it stood, a beat of nothing, fade in where it's going.
    if (t < 0.42) return { ...from, lift: 0, facing: lastFacing, alpha: 1 - t / 0.42, done };
    const facing = heading(to.x - from.x);
    if (t < 0.58) return { ...to, lift: 0, facing, alpha: 0, done };
    return { ...to, lift: 0, facing, alpha: Math.min(1, (t - 0.58) / 0.42), done };
  }
  if (trip.mode === "jetpack") {
    // Straight over everything; the shadow runs along the ground below.
    const p = easeInOut(t);
    const height = 18 + dist(from, to) * 0.07;
    return {
      x: from.x + (to.x - from.x) * p,
      y: from.y + (to.y - from.y) * p,
      lift: done ? 0 : Math.sin(Math.PI * t) * height,
      facing: heading(to.x - from.x),
      alpha: 1,
      done,
    };
  }
  // Feet keep a steady pace; wheels speed up and slow down.
  const progress = trip.mode === "skate" || trip.mode === "bike" ? easeInOut(t) : t;
  const { at, dx } = along(trip.path, pathLength(trip.path) * progress);
  return { ...at, lift: 0, facing: heading(dx), alpha: 1, done };
}
