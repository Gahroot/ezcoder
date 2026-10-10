// Draws a Goal's farm on a canvas at a whole-number pixel scale. The static
// map (ground, buildings, trees, beds) is composed once per size into a cached
// background; each frame then draws only what moves, back to front by how far
// down the map it stands: the fire, steam, koi, petals, the cat, chickens and
// dragonfly, and the critters on foot, skateboard, motorbike or jetpack.

import { CRITTERS, frameRows, type CritterDef } from "./critter-sprites";
import { propGrid, type PropName } from "./critter-props";
import { composeMap } from "./goal-map-compose";
import { stream } from "./goal-map-pixels";
import {
  ART_PALETTE,
  CROWN,
  FLAME_FRAMES,
  JETPACK,
  MOTORBIKE,
  SKATEBOARD,
  type Grid,
} from "./goal-world-art";
import type { WorkKind } from "./goal-world-agents";
import { drawText, GLYPH_H, textWidth } from "./goal-world-font";
import type { Farm } from "./goal-farm-map";
import { ARRIVE_MS, LEAVE_MS, type Actor, type FarmWorld } from "./goal-farm-sim";
import { tripPose } from "./goal-farm-travel";

type Ctx = CanvasRenderingContext2D;

const CRITTER = 14;
const BY_ID = new Map(CRITTERS.map((critter) => [critter.id, critter]));

/** Compose the farm's static map into an offscreen canvas, once per size. */
export function paintFarm(farm: Farm): HTMLCanvasElement {
  const buf = composeMap(farm.scene);
  const canvas = document.createElement("canvas");
  canvas.width = buf.width;
  canvas.height = buf.height;
  canvas.getContext("2d")?.putImageData(buf.toImageData(), 0, 0);
  return canvas;
}

/** Paint a character grid with its top-left at (x, y); `flip` mirrors it. */
function drawGrid(
  ctx: Ctx,
  rows: readonly string[],
  palette: Readonly<Record<string, string>>,
  x: number,
  y: number,
  flip = false,
): void {
  const width = rows[0]?.length ?? 0;
  rows.forEach((row, dy) => {
    let i = 0;
    while (i < row.length) {
      const ch = row[i];
      let end = i + 1;
      while (end < row.length && row[end] === ch) end++;
      const color = ch === undefined || ch === "." ? undefined : palette[ch];
      if (color) {
        ctx.fillStyle = color;
        ctx.fillRect(Math.round(x) + (flip ? width - end : i), Math.round(y) + dy, end - i, 1);
      }
      i = end;
    }
  });
}

const art = (ctx: Ctx, g: Grid, x: number, y: number, flip = false): void =>
  drawGrid(ctx, g.rows, ART_PALETTE, x, y, flip);

function critterDef(id: string): CritterDef {
  const def = BY_ID.get(id) ?? CRITTERS[0];
  if (!def) throw new Error("critter roster is empty");
  return def;
}

/** A soft oval shadow on the ground. */
function shadow(ctx: Ctx, x: number, y: number, rx: number, ry: number, a: number): void {
  ctx.fillStyle = "#2a1406";
  ctx.globalAlpha = a;
  for (let dy = -ry; dy <= ry; dy++) {
    const half = Math.round(rx * Math.sqrt(Math.max(0, 1 - (dy / (ry + 0.5)) ** 2)));
    if (half > 0) ctx.fillRect(Math.round(x) - half, Math.round(y) + dy, half * 2, 1);
  }
  ctx.globalAlpha = 1;
}

// ── What critters hold while they work ───────────────────────

const HELD: Partial<Record<WorkKind, PropName>> = {
  read: "book",
  search: "magnifier",
  edit: "hammer",
  run: "gear",
  web: "laptop",
  think: "paper",
  ask: "letter",
  wait: "mug",
};

function drawHeld(
  ctx: Ctx,
  kind: WorkKind,
  x: number,
  y: number,
  facing: 1 | -1,
  now: number,
): void {
  const name = HELD[kind];
  if (!name) return;
  const grid = propGrid(name);
  const rows = grid.f1 && Math.floor(now / 400) % 2 ? grid.f1 : grid.f0;
  const w = rows[0]?.length ?? 0;
  const bob = kind === "edit" || kind === "run" ? (Math.floor(now / 160) % 2) * -2 : 0;
  drawGrid(ctx, rows, grid.palette, facing === 1 ? x + 4 : x - 4 - w, y - 9 + bob, facing === -1);
}

function drawBubble(ctx: Ctx, text: string, cx: number, top: number, mapWidth: number): void {
  const w = textWidth(text) + 4;
  const h = GLYPH_H + 4;
  const x = Math.min(mapWidth - w - 1, Math.max(1, Math.round(cx - w / 2)));
  const y = Math.round(top - h - 3);
  ctx.fillStyle = "#2a1406";
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  ctx.fillStyle = "#fff8ec";
  ctx.fillRect(x, y, w, h);
  ctx.fillRect(Math.round(cx) - 1, y + h, 3, 1);
  ctx.fillRect(Math.round(cx), y + h + 1, 1, 1);
  drawText(ctx, text, x + 2, y + 2, "#2a1406");
}

// ── The critters ──────────────────────────────────────────────

interface Placed {
  readonly y: number;
  readonly draw: () => void;
}

function actorItems(ctx: Ctx, world: FarmWorld, actor: Actor, now: number, out: Placed[]): void {
  const def = critterDef(actor.critterId);
  let x = actor.spot.x;
  let y = actor.spot.y;
  let lift = 0;
  let facing = actor.facing;
  let alpha = 1;
  const mode = actor.trip?.mode ?? null;
  if (actor.trip) {
    const pose = tripPose(actor.trip, now, actor.facing);
    x = pose.x;
    y = pose.y;
    lift = pose.lift;
    facing = pose.facing;
    alpha = pose.alpha;
  }
  if (actor.state === "arriving") alpha = Math.min(1, (now - actor.stateAt) / ARRIVE_MS + 0.15);
  if (actor.state === "leaving") {
    const t = (now - actor.stateAt) / LEAVE_MS;
    if (t > 0.6) alpha = Math.max(0, 1 - (t - 0.6) / 0.4);
  }
  if (alpha <= 0) return;
  const moving = actor.trip !== null && mode !== "teleport";
  const footing = moving && (mode === "walk" || mode === "run") ? Math.floor(now / 140) % 2 : 0;
  const working = actor.state === "working" && actor.doing !== null;
  const hop =
    working && (actor.doing === "edit" || actor.doing === "run") ? Math.floor(now / 320) % 2 : 0;
  const ride = mode === "skate" ? 3 : mode === "bike" ? 6 : 0;
  const width = world.farm.width;

  out.push({
    y,
    draw: () => {
      // The shadow stays on the ground; a jetpack's shrinks as it climbs.
      shadow(ctx, x, y + 1, lift > 0 ? 4 : 5, 1, (lift > 0 ? 0.18 : 0.3) * alpha);
      const rows = frameRows(def, (moving || hop ? footing || hop : 0) as 0 | 1);
      const left = x - CRITTER / 2;
      const top = y - CRITTER - ride - hop - lift;
      ctx.globalAlpha = alpha;
      if (mode === "teleport" && actor.trip) {
        // A shimmer column where it vanishes and where it appears.
        ctx.fillStyle = def.palette.B ?? "#ffffff";
        ctx.globalAlpha = 0.35 * (1 - alpha * 0.5);
        for (const p of [actor.trip.from, actor.trip.to]) {
          ctx.fillRect(Math.round(p.x) - 4, Math.round(p.y) - 20, 8, 20);
        }
        ctx.globalAlpha = alpha;
      }
      if (mode === "skate") art(ctx, SKATEBOARD, x - 6, y - 3, facing === -1);
      if (mode === "bike") art(ctx, MOTORBIKE, x - 9, y - 9, facing === -1);
      if (mode === "jetpack") {
        const packX = facing === 1 ? left - 3 : left + CRITTER - 2;
        art(ctx, JETPACK, packX, top + 3, facing === -1);
        if (lift > 0) {
          const flame = FLAME_FRAMES[Math.floor(now / 90) % 2];
          if (flame) art(ctx, flame, packX + 1, top + 11);
        }
      }
      drawGrid(ctx, rows, def.palette, left, top, facing === -1);
      if (actor.coordinator) art(ctx, CROWN, x - 3, top - 4);
      if (working && actor.doing) drawHeld(ctx, actor.doing, x, y - hop - lift, facing, now);
      ctx.globalAlpha = 1;
      if (actor.bubble && actor.bubble.until > now) {
        drawBubble(ctx, actor.bubble.text, x, top - (actor.coordinator ? 4 : 0), width);
      }
    },
  });
}

// ── The farm's own life ───────────────────────────────────────

function ambientItems(ctx: Ctx, farm: Farm, now: number, out: Placed[]): void {
  const { ambient } = farm;
  const s = now / 1000;

  // The campfire: flames that flicker and lick, embers drifting up.
  out.push({
    y: ambient.fire.y + 1,
    draw: () => {
      const { x, y } = ambient.fire;
      const t = Math.floor(now / 110);
      for (let row = 0; row < 12; row++) {
        const k = row / 12;
        const sway = Math.round(Math.sin(t * 0.9 + row * 0.7) * k * 1.6);
        const half = Math.max(0, Math.round((1 - k) * 4 + ((t + row) % 3 === 0 ? 1 : 0)));
        if (row > 9 && (t + row) % 2 === 0) continue;
        for (let dx = -half; dx <= half; dx++) {
          ctx.fillStyle = k > 0.62 ? "#ffd060" : Math.abs(dx) < half - 1 ? "#ffe8a0" : "#ff8a2a";
          ctx.fillRect(Math.round(x) + dx + sway, Math.round(y) - 2 - row, 1, 1);
        }
      }
      for (let i = 0; i < 4; i++) {
        const life = (s * 0.9 + i * 0.27) % 1;
        const ex = x + Math.sin(s * 2 + i * 2.1) * 3;
        const ey = y - 12 - life * 16;
        ctx.globalAlpha = 1 - life;
        ctx.fillStyle = i % 2 ? "#ffd060" : "#ff8a2a";
        ctx.fillRect(Math.round(ex), Math.round(ey), 1, 1);
      }
      ctx.globalAlpha = 1;
    },
  });

  // Steam curling up off the kettle and the stove's pots.
  for (const [i, p] of ambient.steam.entries()) {
    out.push({
      y: p.y + 0.5,
      draw: () => {
        for (let k = 0; k < 4; k++) {
          const life = (s * 0.55 + k * 0.25 + i * 0.13) % 1;
          const px = p.x + Math.sin(life * 5 + i) * 2.4 + life * 3;
          const py = p.y - life * 22;
          const r = 1.4 + life * 2.2;
          ctx.globalAlpha = 0.5 * (1 - life);
          ctx.fillStyle = "#ffffff";
          for (let dy = -Math.round(r); dy <= Math.round(r); dy++) {
            const half = Math.round(Math.sqrt(Math.max(0, r * r - dy * dy)));
            ctx.fillRect(Math.round(px) - half, Math.round(py) + dy, half * 2 + 1, 1);
          }
        }
        ctx.globalAlpha = 1;
      },
    });
  }

  // Koi gliding slow loops in the pond.
  const { pond } = ambient;
  for (let i = 0; i < 2; i++) {
    out.push({
      y: pond.y - pond.ry,
      draw: () => {
        const a = s * (i === 0 ? 0.42 : -0.33) + i * 2.6;
        const kx = pond.x + Math.cos(a) * pond.rx * (i === 0 ? 0.62 : 0.4);
        const ky = pond.y + Math.sin(a) * pond.ry * (i === 0 ? 0.55 : 0.4);
        const dir = Math.cos(a + (i === 0 ? Math.PI / 2 : -Math.PI / 2));
        const tail = Math.floor(now / 260) % 2;
        ctx.fillStyle = "#e8742a";
        ctx.fillRect(Math.round(kx) - 3, Math.round(ky), 6, 2);
        ctx.fillRect(Math.round(kx) + (dir > 0 ? -4 : 3), Math.round(ky) - tail, 1, 2 + tail);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(Math.round(kx) + (dir > 0 ? 0 : -1), Math.round(ky), 1, 1);
      },
    });
  }

  // Petals drifting down from the blossom, swaying as they fall.
  for (const [i, tree] of ambient.blossoms.entries()) {
    const rnd = stream(i * 97 + 5);
    const seeds = Array.from({ length: 3 }, () => [rnd(), rnd(), rnd()] as const);
    for (const [k, [ox, phase, speed]] of seeds.entries()) {
      out.push({
        y: tree.y + 40,
        draw: () => {
          const life = (s * (0.12 + speed * 0.08) + phase) % 1;
          const px = tree.x + (ox - 0.5) * tree.r * 2 + Math.sin(life * 9 + k) * 4 + life * 10;
          const py = tree.y - tree.r * 0.4 + life * 46;
          ctx.globalAlpha = life > 0.85 ? (1 - life) / 0.15 : 1;
          ctx.fillStyle = k % 2 ? "#fbd8e0" : "#f2b6c6";
          ctx.fillRect(Math.round(px), Math.round(py), Math.floor(now / 300 + k) % 2 ? 2 : 1, 1);
          ctx.globalAlpha = 1;
        },
      });
    }
  }

  // The cat padding back and forth between its two spots.
  const [c0, c1] = ambient.cat;
  const cycle = (s / 9) % 1;
  const going = cycle < 0.5;
  const leg = going ? cycle * 2 : (cycle - 0.5) * 2;
  const walking = leg < 0.7;
  const tt = walking ? leg / 0.7 : 1;
  const catX = going ? c0.x + (c1.x - c0.x) * tt : c1.x + (c0.x - c1.x) * tt;
  const catY = going ? c0.y + (c1.y - c0.y) * tt : c1.y + (c0.y - c1.y) * tt;
  out.push({
    y: catY,
    draw: () => drawCat(ctx, catX, catY, going ? 1 : -1, walking ? Math.floor(now / 160) % 2 : 0),
  });

  // Chickens, pecking now and then.
  for (const [i, hen] of ambient.chickens.entries()) {
    out.push({
      y: hen.y,
      draw: () => drawHen(ctx, hen.x, hen.y, hen.flip, Math.floor(now / 380 + i * 3) % 5 === 0),
    });
  }

  // The dragonfly, hovering in figure-eights over the water.
  const dx = ambient.dragonfly.x + Math.sin(s * 1.3) * 10;
  const dy = ambient.dragonfly.y + Math.sin(s * 2.6) * 4;
  out.push({
    y: ambient.dragonfly.y + 60,
    draw: () => drawDragonfly(ctx, dx, dy, Math.floor(now / 60) % 2),
  });
}

function drawCat(ctx: Ctx, x: number, y: number, facing: 1 | -1, step: number): void {
  shadow(ctx, x, y + 1, 5, 1, 0.25);
  const px = (dx: number, dy: number, w: number, h: number, c: string): void => {
    ctx.fillStyle = c;
    ctx.fillRect(Math.round(x + (facing === 1 ? dx : -dx - w)), Math.round(y + dy), w, h);
  };
  px(-5, -6, 10, 4, "#c89060");
  px(-4, -3, 7, 1, "#f2dcc0");
  px(-3, -6, 1, 2, "#8a5a34");
  px(0, -6, 1, 2, "#8a5a34");
  px(3, -9, 4, 4, "#c89060");
  px(3, -10, 1, 1, "#c89060");
  px(6, -10, 1, 1, "#c89060");
  px(5, -8, 1, 1, "#2a1a10");
  px(-7, -9 + step, 1, 4, "#c89060");
  px(-4, -2, 1, 2, step ? "#8a5a34" : "#c89060");
  px(-1, -2, 1, 2, step ? "#c89060" : "#8a5a34");
  px(1, -2, 1, 2, step ? "#8a5a34" : "#c89060");
  px(3, -2, 1, 2, step ? "#c89060" : "#8a5a34");
}

function drawHen(ctx: Ctx, x: number, y: number, flip: boolean, pecking: boolean): void {
  shadow(ctx, x, y + 1, 4, 1, 0.24);
  const f = flip ? -1 : 1;
  const px = (dx: number, dy: number, w: number, h: number, c: string): void => {
    ctx.fillStyle = c;
    ctx.fillRect(Math.round(x + (f === 1 ? dx : -dx - w)), Math.round(y + dy), w, h);
  };
  px(-4, -7, 8, 5, "#f6f2ea");
  px(-2, -4, 5, 2, "#d2c8b8");
  const hy = pecking ? -4 : -10;
  px(-6, hy, 4, 4, "#f6f2ea");
  px(-6, hy - 1, 2, 1, "#d8394a");
  px(-7, hy + 1, 1, 1, "#f2b630");
  px(-5, hy + 1, 1, 1, "#2a1a14");
  px(3, -9, 2, 3, "#f6f2ea");
  px(-1, -2, 1, 2, "#f2b630");
  px(1, -2, 1, 2, "#f2b630");
}

function drawDragonfly(ctx: Ctx, x: number, y: number, flap: number): void {
  ctx.fillStyle = "#3a8ad8";
  ctx.fillRect(Math.round(x) - 3, Math.round(y), 7, 1);
  ctx.fillStyle = "#2a5aa8";
  ctx.fillRect(Math.round(x) + 4, Math.round(y), 1, 1);
  ctx.fillStyle = flap ? "#d8ecff" : "#bcd6f0";
  ctx.fillRect(Math.round(x) - 2, Math.round(y) - 2 + flap, 2, 2);
  ctx.fillRect(Math.round(x) + 1, Math.round(y) - 2 + flap, 2, 2);
  ctx.fillRect(Math.round(x) - 2, Math.round(y) + 1 - flap, 2, 2);
  ctx.fillRect(Math.round(x) + 1, Math.round(y) + 1 - flap, 2, 2);
}

/**
 * Draw one frame: the cached map, then everything that moves, back to front.
 * `ambientNow` drives the fire, water, petals and animals; pass a fixed value
 * to hold them still (reduced motion).
 */
export function drawFarm(
  ctx: Ctx,
  background: HTMLCanvasElement,
  world: FarmWorld,
  now: number,
  ambientNow = now,
): void {
  ctx.drawImage(background, 0, 0);
  const items: Placed[] = [];
  ambientItems(ctx, world.farm, ambientNow, items);
  for (const actor of world.actors.values()) actorItems(ctx, world, actor, now, items);
  items.sort((a, b) => a.y - b.y);
  for (const item of items) item.draw();
}
