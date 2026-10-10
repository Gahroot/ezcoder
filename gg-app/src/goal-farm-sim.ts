// The life of a Goal's farm: one actor per agent, each a small state machine.
// Workers come in through the torii gate, travel along the yard's paths to
// the station for whatever they're doing, work there, gather at the tea bench
// by the fire when there's nothing to do, and say goodbye and leave through
// the gate when they finish. GG Goals (the coordinator) lives there for the
// whole goal. Time and randomness are passed in, so a farm replays the same
// way in tests.

import { pickCritter } from "./critter-sprites";
import type { WorkKind, WorldAgent } from "./goal-world-agents";
import { STATION_FOR, type StationKind } from "./goal-world-stations";
import type { Farm } from "./goal-farm-map";
import {
  createRouter,
  planTrip,
  tripPose,
  type Router,
  type Spot,
  type Trip,
} from "./goal-farm-travel";

export type ActorState = "arriving" | "moving" | "working" | "idle" | "leaving";

export interface Bubble {
  readonly text: string;
  readonly until: number;
}

export interface Actor {
  readonly key: string;
  readonly critterId: string;
  readonly coordinator: boolean;
  name: string;
  state: ActorState;
  stateAt: number;
  /** Where its feet are (where its current trip started, while moving). */
  spot: Spot;
  trip: Trip | null;
  facing: 1 | -1;
  /** The station it is at or heading to, and its place there. */
  station: StationKind;
  slot: number;
  /** What it does once it gets there (null: lounging). */
  doing: WorkKind | null;
  /** The latest work it was given. */
  want: WorkKind | null;
  wantAt: number;
  hurry: boolean;
  leaving: "done" | "error" | null;
  bubble: Bubble | null;
  reply: { readonly text: string; readonly at: number } | null;
}

export interface FarmWorld {
  farm: Farm;
  router: Router;
  readonly actors: Map<string, Actor>;
  nextChatAt: number;
  /** False until the first sync: agents already at work then are placed, not walked in. */
  started: boolean;
  readonly random: () => number;
}

/** How long stepping in through the gate takes. */
export const ARRIVE_MS = 700;
/** Goodbye, then out through the gate. */
export const LEAVE_MS = 1500;
const GOODBYE_MS = 800;
/** A critter stays at a station at least this long, so you see it work. */
export const MIN_WORK_MS = 900;
/** A change of work this soon after the last one means it's in a hurry. */
const HURRY_WINDOW_MS = 2500;
const BUBBLE_MS = 1600;
const COORDINATOR_CRITTER = "fox";

const CHAT_LINES = [
  ["Tea?", "Always."],
  ["Nice work!", "Thanks!"],
  ["Almost there.", "Let's go!"],
  ["Need a hand?", "All good!"],
  ["Ship it?", "Soon!"],
  ["Big one today.", "We got this."],
  ["Lovely fire.", "Mm."],
] as const;

export function createFarmWorld(farm: Farm, random: () => number): FarmWorld {
  return {
    farm,
    router: createRouter(farm.paths),
    actors: new Map(),
    nextChatAt: 0,
    started: false,
    random,
  };
}

function stationFor(actor: Pick<Actor, "leaving" | "want">): StationKind {
  if (actor.leaving) return "door";
  return actor.want ? STATION_FOR[actor.want] : "lounge";
}

/** The first free place at `station`, skipping ones other actors hold. */
function freeSlot(world: FarmWorld, actor: Actor, station: StationKind): number {
  const taken = new Set(
    [...world.actors.values()]
      .filter((other) => other.key !== actor.key && other.station === station)
      .map((other) => other.slot),
  );
  let slot = 0;
  while (taken.has(slot)) slot++;
  return slot;
}

/**
 * Where slot `slot` stands at `station`. Past the station's named spots,
 * extra critters fan out in a ring around the first spot.
 */
export function spotAt(farm: Farm, station: StationKind, slot: number): Spot {
  const spots = farm.stations[station];
  const named = spots[slot];
  if (named) return named;
  const base = spots[0] ?? farm.origin;
  const k = slot - spots.length;
  const angle = k * 2.4;
  const r = 12 + Math.floor(k / 5) * 10;
  return {
    x: Math.round(base.x + Math.cos(angle) * r),
    y: Math.round(base.y + Math.sin(angle) * r * 0.5),
  };
}

function say(actor: Actor, text: string, now: number, ms = BUBBLE_MS): void {
  actor.bubble = { text, until: now + ms };
}

function coordinatorOf(world: FarmWorld): Actor | undefined {
  return [...world.actors.values()].find((actor) => actor.coordinator);
}

function spawn(world: FarmWorld, agent: WorldAgent, now: number): Actor {
  const taken = new Set([...world.actors.values()].map((actor) => actor.critterId));
  const critterId = agent.coordinator
    ? COORDINATOR_CRITTER
    : pickCritter(agent.agentName, agent.key, new Set([...taken, COORDINATOR_CRITTER])).id;
  const actor: Actor = {
    key: agent.key,
    critterId,
    coordinator: agent.coordinator,
    name: agent.name,
    state: "idle",
    stateAt: now,
    spot: world.farm.origin,
    trip: null,
    facing: 1,
    station: "lounge",
    slot: 0,
    doing: null,
    want: agent.status === "working" ? agent.kind : null,
    wantAt: now,
    hurry: false,
    leaving: null,
    bubble: null,
    reply: null,
  };
  world.actors.set(actor.key, actor);
  const arriving = world.started && !agent.coordinator;
  actor.station = arriving ? "door" : stationFor(actor);
  actor.slot = freeSlot(world, actor, actor.station);
  actor.spot = spotAt(world.farm, actor.station, actor.slot);
  if (arriving) {
    actor.state = "arriving";
    say(actor, "Hi!", now);
    const coordinator = coordinatorOf(world);
    if (coordinator && !coordinator.reply) coordinator.reply = { text: "Welcome!", at: now + 400 };
  } else {
    actor.doing = actor.want;
    actor.state = actor.doing ? "working" : "idle";
  }
  return actor;
}

/** Bring the farm in line with the current agents. Cheap; call on every change. */
export function syncFarm(world: FarmWorld, agents: readonly WorldAgent[], now: number): void {
  const seen = new Set<string>();
  for (const agent of agents) {
    seen.add(agent.key);
    const finished = agent.status === "done" || agent.status === "error";
    let actor = world.actors.get(agent.key);
    if (!actor) {
      // Someone who finished before the farm saw them has nothing to act out.
      if (finished) continue;
      actor = spawn(world, agent, now);
    }
    actor.name = agent.name;
    const want = agent.status === "working" ? agent.kind : null;
    if (want !== actor.want) {
      actor.hurry = now - actor.wantAt < HURRY_WINDOW_MS;
      actor.want = want;
      actor.wantAt = now;
    }
    if (finished && !actor.coordinator && !actor.leaving) {
      actor.leaving = agent.status === "error" ? "error" : "done";
    }
  }
  for (const actor of world.actors.values()) {
    if (!seen.has(actor.key) && !actor.coordinator && !actor.leaving) actor.leaving = "done";
  }
  world.started = true;
}

/**
 * A new farm (the view resized, so the countryside grew or shrank): everyone
 * settles where they were headed. The farmstead may have moved on the map.
 */
export function resizeFarm(world: FarmWorld, farm: Farm): void {
  world.farm = farm;
  world.router = createRouter(farm.paths);
  for (const actor of world.actors.values()) {
    actor.trip = null;
    actor.spot = spotAt(farm, actor.station, actor.slot);
    if (actor.state === "moving") actor.state = actor.doing ? "working" : "idle";
  }
}

function startLeaving(world: FarmWorld, actor: Actor, now: number): void {
  actor.state = "leaving";
  actor.stateAt = now;
  actor.doing = null;
  say(actor, actor.leaving === "error" ? "Oops. Bye!" : "Done. Bye!", now, GOODBYE_MS + 200);
  const coordinator = coordinatorOf(world);
  if (coordinator && actor.leaving === "done") {
    coordinator.reply = { text: "Thanks!", at: now + 500 };
  }
}

function settle(actor: Actor, now: number): void {
  const doing = actor.want;
  const next: ActorState = doing ? "working" : "idle";
  if (actor.state !== next || actor.doing !== doing) {
    actor.state = next;
    actor.stateAt = now;
  }
  actor.doing = doing;
}

/**
 * Advance every actor to `now`. With `instant` (reduced motion, a background
 * window) nobody travels: they appear where they're going.
 */
export function stepFarm(world: FarmWorld, now: number, instant = false): void {
  for (const actor of [...world.actors.values()]) {
    if (actor.trip) {
      const pose = tripPose(actor.trip, now, actor.facing);
      actor.facing = pose.facing;
      if (!pose.done && !instant) continue;
      actor.spot = actor.trip.to;
      actor.trip = null;
      actor.state = "idle";
      actor.stateAt = now;
    }
    if (actor.state === "arriving") {
      if (now - actor.stateAt < ARRIVE_MS && !instant) continue;
      actor.state = "idle";
      actor.stateAt = now;
    }
    if (actor.state === "leaving") {
      if (now - actor.stateAt >= LEAVE_MS || instant) world.actors.delete(actor.key);
      continue;
    }
    // Give a working critter a moment at its station before moving on.
    const target = stationFor(actor);
    if (
      actor.state === "working" &&
      !actor.leaving &&
      target !== actor.station &&
      now - actor.stateAt < MIN_WORK_MS &&
      !instant
    ) {
      continue;
    }
    if (target !== actor.station) {
      actor.station = target;
      actor.slot = freeSlot(world, actor, target);
    }
    const goal = spotAt(world.farm, actor.station, actor.slot);
    const there = Math.hypot(goal.x - actor.spot.x, goal.y - actor.spot.y) < 1;
    if (there || instant) {
      if (!there) {
        actor.facing = goal.x >= actor.spot.x ? 1 : -1;
        actor.spot = goal;
      }
      if (actor.leaving) startLeaving(world, actor, now);
      else settle(actor, now);
      continue;
    }
    actor.trip = planTrip(world.router.route(actor.spot, goal), {
      hurry: actor.hurry || actor.leaving !== null,
      roll: world.random(),
      now,
    });
    actor.state = "moving";
    actor.stateAt = now;
  }
  chatter(world, now);
  for (const actor of world.actors.values()) {
    if (actor.bubble && actor.bubble.until <= now) actor.bubble = null;
    if (actor.reply && actor.reply.at <= now) {
      say(actor, actor.reply.text, now);
      actor.reply = null;
    }
  }
}

/** Critters lounging by the fire chat now and then; a lone one sips its tea. */
function chatter(world: FarmWorld, now: number): void {
  if (now < world.nextChatAt) return;
  world.nextChatAt = now + 3500 + world.random() * 3500;
  const lounging = [...world.actors.values()]
    .filter((actor) => actor.state === "idle" && actor.station === "lounge" && !actor.bubble)
    .sort((a, b) => a.key.localeCompare(b.key));
  if (lounging.length >= 2) {
    const first = Math.floor(world.random() * lounging.length);
    const a = lounging[first];
    const b = lounging[(first + 1) % lounging.length];
    const line = CHAT_LINES[Math.floor(world.random() * CHAT_LINES.length)] ?? CHAT_LINES[0];
    if (!a || !b) return;
    say(a, line[0], now);
    a.facing = b.spot.x >= a.spot.x ? 1 : -1;
    b.facing = a.spot.x >= b.spot.x ? 1 : -1;
    b.reply = { text: line[1], at: now + 1100 };
  } else if (lounging.length === 1 && world.random() < 0.35) {
    const only = lounging[0];
    if (only) say(only, "*sip*", now, 1100);
  }
}

/** True while anyone is travelling, arriving or leaving: worth drawing smoothly. */
export function farmIsMoving(world: FarmWorld): boolean {
  for (const actor of world.actors.values()) {
    if (actor.trip || actor.state === "arriving" || actor.state === "leaving") return true;
  }
  return false;
}
