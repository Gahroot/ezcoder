// Composes a top-down Goal map: the painted ground, then every prop and
// critter sorted by how far down the map it stands (so a critter walking
// "behind" a tree is covered by it), each with a soft shadow, then speech
// bubbles and labels on top. Pure: the same scene always paints the same
// pixels, so the mockups and the eventual live view can share it.

import { CRITTERS, frameRows } from "./critter-sprites";
import { GLYPHS as GLYPHS_3X5 } from "./goal-world-font";
import { paintGround, scatterDetails, type MapGrid } from "./goal-map-ground";
import { E, PixelBuffer, darken, type Rgb } from "./goal-map-pixels";
import type { Sprite } from "./goal-map-props";

export interface PlacedProp {
  readonly sprite: Sprite;
  /** Where its anchor stands, in map pixels. */
  readonly x: number;
  readonly y: number;
  readonly flip?: boolean;
  /** Painted flat on the ground, under everything that stands (rugs, pads). */
  readonly flat?: boolean;
}

export interface PlacedCritter {
  readonly id: string;
  /** Where its feet are, in map pixels. */
  readonly x: number;
  readonly y: number;
  readonly flip?: boolean;
  readonly frame?: 0 | 1;
  /** GG Goals wears a crown. */
  readonly crown?: boolean;
  /** Held up in front, like a book or a mug. */
  readonly holding?: Sprite;
  readonly say?: string;
  /** Rides something: drawn under the critter, which sits on top. */
  readonly ride?: Sprite;
  /** Airborne (jetpack): drawn this far above its feet; the shadow stays down. */
  readonly lift?: number;
}

export interface MapScene {
  readonly grid: MapGrid;
  readonly seed: number;
  readonly props: readonly PlacedProp[];
  readonly critters: readonly PlacedCritter[];
  /** Station names shown as small tags, for the mockups. */
  readonly labels?: ReadonlyArray<{
    readonly text: string;
    readonly x: number;
    readonly y: number;
  }>;
  /** A cool night grade over the whole map, for variety in the mockups. */
  readonly tint?: { readonly color: Rgb; readonly a: number };
  /**
   * Swap ground colours after painting (standard palette → this world's), so
   * one painter serves every look. Props and critters are not remapped.
   */
  readonly groundColors?: ReadonlyMap<Rgb, Rgb>;
  /** What shadows darken toward (a warm brown for cosy worlds). */
  readonly ink?: Rgb;
  /** Hide the station name tags (the cosy scenes read without them). */
  readonly hideLabels?: boolean;
}

const BY_ID = new Map(CRITTERS.map((critter) => [critter.id, critter]));

function shadow(
  buf: PixelBuffer,
  x: number,
  y: number,
  rx: number,
  ry: number,
  a = 0.3,
  ink: Rgb = E.ink,
): void {
  for (let yy = Math.floor(y - ry); yy <= y + ry; yy++) {
    for (let xx = Math.floor(x - rx); xx <= x + rx; xx++) {
      const dx = (xx + 0.5 - x) / rx;
      const dy = (yy + 0.5 - y) / ry;
      if (dx * dx + dy * dy > 1 || !buf.inside(xx, yy)) continue;
      buf.set(xx, yy, darken(buf.rgb(xx, yy), 0.5, ink), a / 0.3 > 1 ? 1 : a / 0.3);
    }
  }
}

function drawProp(buf: PixelBuffer, p: PlacedProp, ink: Rgb): void {
  const { sprite } = p;
  if (sprite.shadow) {
    const s = sprite.shadow;
    shadow(buf, p.x + (s.dx ?? 0), p.y + (s.dy ?? 0), s.rx, s.ry, s.a ?? 0.3, ink);
  }
  const ax = p.flip ? sprite.buf.width - 1 - sprite.ax : sprite.ax;
  buf.draw(sprite.buf, p.x - ax, p.y - sprite.ay, p.flip ?? false);
}

const CRITTER = 14;

function critterBuffer(id: string, frame: 0 | 1): PixelBuffer {
  const def = BY_ID.get(id) ?? CRITTERS[0];
  const out = new PixelBuffer(CRITTER, CRITTER);
  if (def) out.stamp(frameRows(def, frame), def.palette, 0, 0);
  return out;
}

const CROWN = ["y..y..y", "yy.y.yy", "yyyyyyy", "ooooooo"];

function drawCritter(buf: PixelBuffer, c: PlacedCritter, ink: Rgb): void {
  const lift = c.lift ?? 0;
  shadow(buf, c.x, c.y, lift > 0 ? 5 : 6, lift > 0 ? 1.6 : 2.2, lift > 0 ? 0.22 : 0.34, ink);
  const rideH = c.ride ? c.ride.buf.height - 2 : 0;
  if (c.ride) {
    const r = c.ride;
    buf.draw(
      r.buf,
      c.x - (c.flip ? r.buf.width - 1 - r.ax : r.ax),
      c.y - r.ay - lift,
      c.flip ?? false,
    );
  }
  const left = Math.round(c.x - CRITTER / 2);
  const top = Math.round(c.y - CRITTER - rideH - lift);
  buf.draw(critterBuffer(c.id, c.frame ?? 0), left, top, c.flip ?? false);
  if (c.crown) buf.stamp(CROWN, { y: E.gold, o: E.amber }, left + 3, top - 3);
  if (c.holding) {
    const h = c.holding;
    const hx = c.flip ? left - h.buf.width + 5 : left + CRITTER - 5;
    buf.draw(h.buf, hx, top + 7, c.flip ?? false);
  }
}

/** Width of `text` in the 3×5 font, in pixels. */
export function textWidth(text: string): number {
  return text.length === 0 ? 0 : text.length * 4 - 1;
}

function drawText(buf: PixelBuffer, text: string, x: number, y: number, color: Rgb): void {
  let left = Math.round(x);
  for (const ch of text.toUpperCase()) {
    const glyph = GLYPHS_3X5[ch] ?? GLYPHS_3X5["?"] ?? [];
    glyph.forEach((row, dy) => {
      for (let dx = 0; dx < row.length; dx++)
        if (row[dx] === "#") buf.set(left + dx, y + dy, color);
    });
    left += 4;
  }
}

/** A speech bubble with a tail, pointing down at (cx, bottom). */
function drawBubble(buf: PixelBuffer, text: string, cx: number, bottom: number): void {
  const w = textWidth(text) + 6;
  const h = 11;
  const x = Math.min(buf.width - w - 2, Math.max(2, Math.round(cx - w / 2)));
  const y = Math.round(bottom - h - 4);
  // Rounded body: cut the corners, ring it in ink.
  buf.rect(x + 1, y, w - 2, h, E.ink);
  buf.rect(x, y + 1, w, h - 2, E.ink);
  buf.rect(x + 1, y + 1, w - 2, h - 2, E.cream);
  buf.rect(x + 1, y + h - 2, w - 2, 1, E.sand);
  // Tail.
  const tx = Math.round(cx);
  buf.rect(tx - 2, y + h - 1, 5, 1, E.cream);
  buf.set(tx - 3, y + h - 1, E.ink);
  buf.set(tx + 3, y + h - 1, E.ink);
  buf.rect(tx - 1, y + h, 3, 1, E.cream);
  buf.set(tx - 2, y + h, E.ink);
  buf.set(tx + 2, y + h, E.ink);
  buf.set(tx, y + h + 1, E.cream);
  buf.set(tx - 1, y + h + 1, E.ink);
  buf.set(tx + 1, y + h + 1, E.ink);
  buf.set(tx, y + h + 2, E.ink);
  drawText(buf, text, x + 3, y + 3, E.bark0);
}

/** A small dark tag naming a station. */
function drawLabel(buf: PixelBuffer, text: string, cx: number, y: number): void {
  const w = textWidth(text) + 6;
  const x = Math.round(cx - w / 2);
  buf.rect(x + 1, y, w - 2, 9, E.ink, 0.78);
  buf.rect(x, y + 1, w, 7, E.ink, 0.78);
  drawText(buf, text, x + 3, y + 2, E.cream);
}

/** Swap exact colours in place; colours not in the map are left as they are. */
function recolor(buf: PixelBuffer, map: ReadonlyMap<Rgb, Rgb>): void {
  const d = buf.data;
  for (let i = 0; i < d.length; i += 4) {
    const c = ((d[i] ?? 0) << 16) | ((d[i + 1] ?? 0) << 8) | (d[i + 2] ?? 0);
    const to = map.get(c);
    if (to === undefined) continue;
    d[i] = (to >> 16) & 255;
    d[i + 1] = (to >> 8) & 255;
    d[i + 2] = to & 255;
  }
}

/** Paint a whole map scene. */
export function composeMap(scene: MapScene): PixelBuffer {
  const ground = paintGround(scene.grid, scene.seed);
  scatterDetails(ground, scene.seed);
  const buf = ground.buf;
  if (scene.groundColors) recolor(buf, scene.groundColors);

  const ink = scene.ink ?? E.ink;
  for (const p of scene.props) if (p.flat) drawProp(buf, p, ink);
  type Item = { y: number; x: number; draw: () => void };
  const items: Item[] = [];
  for (const p of scene.props) {
    if (!p.flat) items.push({ y: p.y, x: p.x, draw: () => drawProp(buf, p, ink) });
  }
  for (const c of scene.critters) {
    items.push({ y: c.y + 0.5, x: c.x, draw: () => drawCritter(buf, c, ink) });
  }
  items.sort((a, b) => a.y - b.y || a.x - b.x);
  for (const item of items) item.draw();

  if (scene.tint) {
    for (let y = 0; y < buf.height; y++) {
      for (let x = 0; x < buf.width; x++) buf.set(x, y, scene.tint.color, scene.tint.a);
    }
  }
  if (!scene.hideLabels) {
    for (const label of scene.labels ?? []) drawLabel(buf, label.text, label.x, label.y);
  }
  for (const c of scene.critters) {
    if (!c.say) continue;
    const rideH = c.ride ? c.ride.buf.height - 2 : 0;
    drawBubble(buf, c.say, c.x, c.y - CRITTER - rideH - (c.lift ?? 0) - (c.crown ? 3 : 0));
  }
  return buf;
}
