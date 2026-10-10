// High-angle ("3/4 from above") art for the cosy Goal world. The camera looks
// down at about 60°, so for anything that stands up the TOP is the biggest
// thing you see: a roof is mostly roof, a tub is mostly its rim and water, a
// tree is mostly canopy. Vertical faces are short bands under their tops.
// Matched pixel by pixel against hand-made farm-sim art. Pure.

import { PixelBuffer, hash, mix, noise, stream, type Rgb } from "./goal-map-pixels";
import type { Sprite } from "./goal-map-props";
import { THATCH, W, blob, paintBay, thatchBlotch, type Bay } from "./goal-map-farm";

const LINE: Rgb = 0x3a1406;

function sprite(
  w: number,
  h: number,
  ax: number,
  ay: number,
  draw: (b: PixelBuffer) => void,
  shadow?: Sprite["shadow"],
  outline = 0.86,
): Sprite {
  const buf = new PixelBuffer(w, h);
  draw(buf);
  if (outline > 0) buf.outline(outline, LINE);
  return { buf, ax, ay, ...(shadow ? { shadow } : {}) };
}

/** Thatch colour at (x, y): mid-brown with ragged lighter patches and darker hollows. */
function thatchAt(x: number, y: number, seed: number, light: number): Rgb {
  const lift = thatchBlotch(x, y, seed);
  const hollow = noise(x * 0.4, y * 1.3, 5, seed + 3) < 0.18;
  let c: Rgb =
    lift > 0
      ? lift > 0.55 && light > 0
        ? THATCH.hi
        : mix(THATCH.base, THATCH.hi, 0.6)
      : THATCH.base;
  if (hollow && lift <= 0) c = THATCH.lo;
  if (light < -0.35 && lift < 0.4) c = THATCH.lo;
  if (light < -0.7) c = mix(THATCH.lo, THATCH.deep, 0.45);
  return c;
}

/**
 * The farmhouse from above. The hipped thatch is most of the picture: a
 * ridge high up, a long front slope rolling down to a thick, ragged eave, and
 * the two hip ends falling away on either side (lit on the left, in shade on
 * the right). Under the eave, a short band of the front: posts, varied bays,
 * a deep veranda deck seen from above, the step stones in front.
 */
export function farmhouseTop(seed: number, bays: readonly Bay[], noren: Rgb): Sprite {
  const bay = 30;
  const front = bays.length * bay + 6;
  const over = 12; // the eave overhangs each end
  const w = front + over * 2;
  const roofDepth = Math.round(front * 0.36) + 30; // how far back the roof runs
  const fringe = 7;
  const eaveY = roofDepth;
  const lintel = eaveY + 1;
  const wallH = 20; // the walls are short: we see them from above
  const deckY = lintel + wallH;
  const deckH = 12; // the deck is deep: we see its top
  const h = deckY + deckH + 5;
  const left = over;
  const ridgeL = Math.round(w * 0.2);
  const ridgeR = Math.round(w * 0.8);
  const ridgeY = 6;
  return sprite(
    w,
    h,
    Math.round(w / 2),
    deckY + deckH + 2,
    (b) => {
      // ── The front: bays under a lintel, posts, the eave's deep shadow ──
      b.rect(left, lintel, front, wallH, W.deep);
      bays.forEach((kind, i) => {
        const bx = left + 3 + i * bay;
        paintBay(
          b,
          kind,
          bx + 3,
          lintel + 2,
          bay - 6,
          wallH - 2,
          seed + i * 13,
          i === bays.indexOf("room") ? noren : undefined,
        );
      });
      for (let i = 0; i <= bays.length; i++) {
        const px = left + i * bay;
        b.rect(px, lintel, 5, wallH, W.warm);
        b.rect(px + 1, lintel, 1, wallH, W.hi);
        b.rect(px + 3, lintel, 1, wallH, W.base);
      }
      for (let x = left; x < left + front; x++) {
        for (let k = 0; k < 7; k++) b.set(x, lintel + k, LINE, 0.62 - k * 0.085);
      }
      // ── The veranda deck, seen from above: long boards running along ──
      for (let y = 0; y < deckH; y++) {
        for (let x = left - 8; x < left + front + 8; x++) {
          let c: Rgb;
          if (y >= deckH - 2)
            c = y === deckH - 1 ? W.line : W.shadow; // its front edge
          else if (y === 0)
            c = W.shadow; // the shadow line under the wall
          else {
            const board = y % 3 === 0;
            const joint = (x + Math.floor(y / 3) * 31) % 47 === 0;
            const tone = hash(
              Math.floor((x + Math.floor(y / 3) * 31) / 47),
              Math.floor(y / 3),
              seed + 5,
            );
            c =
              board || joint
                ? W.base
                : y % 3 === 1
                  ? W.light
                  : tone < 0.4
                    ? W.warm
                    : mix(W.warm, W.light, 0.4);
          }
          b.set(x, deckY + y, c);
        }
      }
      // The posts' feet on the deck, and things left out on it.
      for (let i = 0; i <= bays.length; i++) b.rect(left + i * bay, deckY, 5, 2, W.face);
      const rnd = stream(seed + 30);
      const cushionX = left + bay * 2 + 8;
      b.rect(cushionX, deckY + 3, 9, 5, 0xc0503a);
      b.rect(cushionX, deckY + 3, 9, 1, 0xe07a5a);
      const teaX = left + bay * 4 + 10;
      b.rect(teaX, deckY + 4, 8, 4, W.face);
      b.rect(teaX + 2, deckY + 2, 3, 3, 0xe8e2d4);
      b.rect(teaX + 5, deckY + 3, 2, 2, 0xe8e2d4);
      // Sandals at the step in front of the open room.
      const sx = left + bay * (bays.indexOf("room") >= 0 ? bays.indexOf("room") : 2) + 10;
      b.rect(sx, deckY + deckH - 4, 3, 2, 0x5a3418);
      b.rect(sx + 5, deckY + deckH - 4, 3, 2, 0x5a3418);

      // ── The roof: front slope, hips, ridge, fringe ──
      for (let y = 0; y < roofDepth; y++) {
        // Where the roof's outline is at this row: narrow at the ridge, the
        // full eave width at the bottom, curving out like a heavy thatch.
        const t = y / roofDepth;
        const half = Math.round(
          (ridgeR - ridgeL) / 2 +
            4 +
            Math.sin((Math.min(1, t * 1.25) * Math.PI) / 2) * ((w - (ridgeR - ridgeL)) / 2 - 4),
        );
        const cx = w / 2;
        // The hip seams: lines from the ridge's ends down to the eave's corners.
        const seamL = ridgeL + (0 - ridgeL) * Math.min(1, (y - ridgeY) / (roofDepth - ridgeY));
        const seamR = ridgeR + (w - ridgeR) * Math.min(1, (y - ridgeY) / (roofDepth - ridgeY));
        for (let x = Math.round(cx - half); x < Math.round(cx + half); x++) {
          // Which face: the left hip, the right hip, or the front slope.
          const onLeftHip = x < seamL;
          const onRightHip = x > seamR;
          const light = onLeftHip ? 0.5 : onRightHip ? -0.75 : 0.15 - t * 0.2;
          let c = thatchAt(x, y, seed, light);
          // The seams themselves: a darker crease.
          if (Math.abs(x - seamL) < 1 || Math.abs(x - seamR) < 1) c = THATCH.lo;
          if (Math.abs(x - seamR) < 2 && onRightHip) c = mix(THATCH.lo, THATCH.deep, 0.5);
          b.set(x, y, c);
        }
      }
      // The ridge: a long, rounded roll capped with dark beams.
      b.rect(ridgeL, ridgeY - 4, ridgeR - ridgeL, 7, THATCH.lo);
      b.rect(ridgeL, ridgeY - 4, ridgeR - ridgeL, 2, THATCH.hi);
      b.rect(ridgeL + 2, ridgeY, ridgeR - ridgeL - 4, 2, THATCH.deep);
      for (let x = ridgeL + 8; x < ridgeR - 8; x += 13) b.rect(x, ridgeY - 4, 3, 7, W.deep);
      // A smoke vent in the middle of the ridge.
      const vx = Math.round(w / 2) - 7;
      b.rect(vx, ridgeY - 5, 14, 7, W.face);
      for (let k = 0; k < 4; k++) b.rect(vx + 2 + k * 3, ridgeY - 4, 1, 5, W.line);
      // Moss in the hollows near the bottom of the front slope.
      for (let i = 0; i < 26; i++) {
        const mx = Math.round(ridgeL + rnd() * (ridgeR - ridgeL));
        const my = Math.round(roofDepth * 0.55 + rnd() * roofDepth * 0.35);
        if (b.opaque(mx, my)) {
          b.set(mx, my, THATCH.moss);
          if (rnd() < 0.5) b.set(mx + 1, my, THATCH.moss);
        }
      }
      // The fringe: a thick, ragged lip of straw along the eave.
      for (let x = 0; x < w; x++) {
        const tooth = Math.floor(hash(Math.floor(x / 2), 3, seed) * 4);
        for (let k = 0; k < fringe; k++) {
          const y = eaveY - fringe + k;
          if (!b.opaque(x, y)) continue;
          b.set(
            x,
            y,
            k >= fringe - 2 - (tooth % 2) ? THATCH.deep : k > 1 ? THATCH.lo : THATCH.base,
          );
        }
        if (b.opaque(x, eaveY - 1) && tooth > 1) b.set(x, eaveY, THATCH.deep);
      }
    },
    { rx: w / 2 - 4, ry: 8, dx: 8, dy: -3, a: 0.34 },
  );
}

/** Golden storehouse thatch: lighter and warmer than the farmhouse's. */
const KT = {
  line: 0x5a2410,
  deep: 0x5e3416,
  shade: 0x7c5328,
  lo: 0x93693a,
  base: 0xab814a,
  light: 0xb98e54,
  hi: 0xc69c60,
  sun: 0xd6b072,
  moss: 0x8a922f,
} as const;

/** The storehouse's golden boards. */
const KW = {
  line: 0x5a2410,
  seam: 0x93622f,
  dark: 0xa8763a,
  board: 0xbe8a47,
  lit: 0xd0a05a,
  hi: 0xe0b878,
  shadow: 0x6e3c18,
} as const;

/** The stone platform a storehouse stands on. */
const PLINTH = {
  hi: 0xf0ece6,
  top: 0xd8d2ca,
  shade: 0xb4ada4,
  face: 0xa39b92,
  joint: 0x7e766e,
  foot: 0x6a625b,
} as const;

/**
 * Small, rounded clumps of straw on a jittered grid, with ragged edges:
 * how hand-drawn thatch reads (blobs, not streaks). 0 outside a clump.
 */
function strawClump(x: number, y: number, seed: number, density = 0.55): number {
  const cw = 7;
  const ch = 6;
  let best = 0;
  const gx0 = Math.floor(x / cw);
  const gy0 = Math.floor(y / ch);
  for (let gy = gy0 - 1; gy <= gy0 + 1; gy++) {
    for (let gx = gx0 - 1; gx <= gx0 + 1; gx++) {
      if (hash(gx, gy, seed) > density) continue;
      const ox = gx * cw + hash(gx, gy, seed + 1) * cw;
      const oy = gy * ch + hash(gx, gy, seed + 2) * ch;
      const rx = 1.9 + hash(gx, gy, seed + 3) * 2.6;
      const ry = 1.3 + hash(gx, gy, seed + 4) * 1.5;
      const ragged = (noise(x, y, 1.6, seed + 5) - 0.5) * 0.7;
      const d = ((x + 0.5 - ox) / rx) ** 2 + ((y + 0.5 - oy) / ry) ** 2 - ragged;
      best = Math.max(best, 1 - d);
    }
  }
  return best;
}

/**
 * A kura (storehouse) from above, built the way a pixel artist builds one:
 *
 * - a long hip-and-gable thatch running back from the viewer, its back
 *   rounding down like an arch from a wide ridge roll that runs down the
 *   middle (lit on its left, its straw ties showing as dashes on both edges,
 *   a dark crease where each slope rises to meet it);
 * - two side slopes of clumpy golden straw, the left in the sun, each lighter
 *   in its middle and darker at the ridge and the eave;
 * - at the front, a wide gable recess in deep shadow under the ridge's end:
 *   light board slats behind dark bargeboards, a vent, a lit tie beam and a
 *   row of rafter ends, the slopes darkening into a hood around it;
 * - a deep front skirt of sunlit straw with a ragged fringe;
 * - a golden board wall with lit posts on a sill, on a thin stone platform.
 */
export function kuraTop(seed: number): Sprite {
  const w = 66;
  const h = 122;
  const cx = 32.5;
  const RIDGE_L = 26;
  const RIDGE_R = 39;
  const RIDGE_TOP = 2;
  const RIDGE_END = 62;
  const GABLE_BASE = 78;
  const SKIRT = 82;
  const FRINGE = 93;
  const WALL_TOP = 96;
  const WALL_BOTTOM = 111;
  const WALL_L = 9;
  const WALL_R = 56;

  /** The slopes' top edge: an arch falling away from the ridge. */
  const roofTop = (x: number): number => {
    if (x >= RIDGE_L && x <= RIDGE_R)
      return x === RIDGE_L || x === RIDGE_R ? RIDGE_TOP + 1 : RIDGE_TOP;
    const t = x < RIDGE_L ? (RIDGE_L - x) / (RIDGE_L - 3) : (x - RIDGE_R) / (w - 4 - RIDGE_R);
    return Math.round(5 + 20 * (1 - Math.sqrt(Math.max(0, 1 - Math.min(1, t) ** 2))));
  };
  /** The side eaves: leaning out a little toward the front, rounding in at the corners. */
  const sideL = (y: number): number => {
    if (y < 40) return 4;
    if (y <= 86) return 3;
    if (y <= 91) return 3 + Math.round(5 - Math.sqrt(Math.max(0, 25 - (y - 86) ** 2)));
    return 8;
  };
  // Opens from the ridge's width to ~4/5 of the roof: broad and shallow.
  const gableHalf = (y: number): number =>
    7 + (Math.min(y, GABLE_BASE) - RIDGE_END) * (17 / (GABLE_BASE - RIDGE_END));
  const gableDist = (x: number, y: number): number => Math.abs(x + 0.5 - (cx + 0.5)) - gableHalf(y);
  const inGable = (x: number, y: number): boolean =>
    y > RIDGE_END && y <= GABLE_BASE + 3 && gableDist(x, y) <= 0;

  /** Straw on a slope or the skirt: clumps of light straw, darker hollows. */
  const straw = (x: number, y: number, lit: number, s: number): Rgb => {
    const lift = strawClump(x * 0.8, y * 0.85, s, 0.4);
    const hollow = strawClump(x * 0.8 + 3, y * 0.85 + 2, s + 50, 0.18);
    let c: Rgb = lit > 0.5 ? KT.light : lit > 0 ? KT.base : mix(KT.base, KT.lo, 0.45);
    if (lift > 0.45) c = lit > 0 ? KT.sun : KT.hi;
    else if (lift > 0) c = lit > 0 ? KT.hi : KT.light;
    else if (hollow > 0.2) c = lit > 0 ? KT.lo : KT.shade;
    return c;
  };

  return sprite(
    w,
    h,
    33,
    h - 3,
    (b) => {
      // ── The stone platform: a thin pale border around the wall ──
      for (let y = 92; y <= 117; y++) {
        for (let x = 6; x <= 59; x++) {
          let c: Rgb;
          if (y >= 114) {
            c = y === 117 ? PLINTH.foot : (x - 6) % 9 === 0 ? PLINTH.joint : PLINTH.face;
            if (y === 114 && (x - 6) % 9 !== 0) c = PLINTH.shade;
          } else {
            c = x >= 57 ? PLINTH.shade : PLINTH.top;
            if (x === 6 || y === 113) c = PLINTH.hi;
          }
          b.set(x, y, c);
        }
      }

      // ── The board wall, its posts and sill ──
      for (let y = WALL_TOP; y <= WALL_BOTTOM; y++) {
        for (let x = WALL_L; x <= WALL_R; x++) {
          const k = (x - WALL_L) % 5;
          let c: Rgb = k === 0 ? KW.seam : k === 1 ? KW.lit : KW.board;
          if (hash(x, y >> 1, seed + 31) < 0.05 && k > 1) c = KW.dark; // grain
          b.set(x, y, c);
        }
      }
      for (const [px, lit] of [
        [WALL_L, true],
        [31, true],
        [WALL_R - 3, false],
      ] as const) {
        for (let y = WALL_TOP; y <= WALL_BOTTOM; y++) {
          b.set(px, y, KW.line);
          b.set(px + 1, y, lit ? KW.hi : KW.lit);
          b.set(px + 2, y, lit ? KW.lit : KW.board);
          b.set(px + 3, y, KW.seam);
        }
      }
      for (let x = WALL_L; x <= WALL_R; x++) {
        b.set(x, WALL_BOTTOM - 1, KW.hi); // the sill's lit edge
        b.set(x, WALL_BOTTOM, KW.dark);
        // The deep eave's shadow over the top of the wall.
        b.set(x, WALL_TOP, KW.shadow);
        b.set(x, WALL_TOP + 1, mix(b.rgb(x, WALL_TOP + 1), KW.shadow, 0.7));
        b.set(x, WALL_TOP + 2, mix(b.rgb(x, WALL_TOP + 2), KW.shadow, 0.35));
      }

      // ── The roof's slopes and skirt ──
      for (let y = 0; y <= FRINGE + 3; y++) {
        const l = sideL(y);
        const r = w - 1 - l;
        for (let x = l; x <= r; x++) {
          if (y < roofTop(x)) continue;
          if (y >= SKIRT) {
            // The front skirt: deep, sunlit straw with a ragged fringe.
            if (y >= FRINGE) {
              const tooth = Math.floor(hash(x >> 1, 7, seed) * 4);
              if (y > FRINGE + tooth) continue;
              b.set(x, y, y === FRINGE + tooth ? KT.deep : KT.lo);
              continue;
            }
            let c = straw(x, y + 60, 1, seed + 2);
            if (y === SKIRT)
              c = KT.deep; // shade under the rafter ends
            else if (y === SKIRT + 1) c = mix(c, KT.shade, 0.6);
            if (x <= l + 1 || x >= r - 1) c = mix(c, KT.shade, 0.5);
            b.set(x, y, c);
            continue;
          }
          if (x >= RIDGE_L && x <= RIDGE_R && y <= RIDGE_END) continue; // the ridge, below
          if (inGable(x, y)) continue; // the gable, below
          const leftSide = x < cx;
          // Each slope is lit in its middle, darker toward the ridge and the eave.
          const span = leftSide ? RIDGE_L - l : r - RIDGE_R;
          const along = leftSide ? (x - l) / span : (r - x) / span;
          const lit = (leftSide ? 0.6 : -0.3) + (along > 0.2 && along < 0.8 ? 0.2 : -0.25);
          let c = straw(x, y, lit, seed);
          // The creases where the slopes rise to meet the ridge.
          const toRidge = leftSide ? RIDGE_L - 1 - x : x - RIDGE_R - 1;
          if (y <= RIDGE_END + 2 && toRidge >= 0 && toRidge < 3) {
            c = mix(
              c,
              leftSide ? KT.lo : KT.deep,
              toRidge === 0 ? 0.85 : toRidge === 1 ? 0.5 : 0.25,
            );
          }
          // The eaves: a darker rim just inside the outline.
          if (x === l || x === r) c = leftSide ? KT.lo : KT.shade;
          // The hood: the slopes darken into the gable's valleys.
          if (y > RIDGE_END - 3 && y < SKIRT) {
            const away = gableDist(x, Math.max(y, RIDGE_END + 1));
            if (away < 6) c = mix(c, KT.deep, Math.max(0, 0.85 - away * 0.15));
          }
          // The front corners turn away from the light.
          if (y > 72 && (x - l < 7 || r - x < 7)) c = mix(c, KT.shade, 0.4);
          b.set(x, y, c);
        }
      }

      // ── The ridge roll ──
      for (let y = RIDGE_TOP; y <= RIDGE_END; y++) {
        for (let x = RIDGE_L; x <= RIDGE_R; x++) {
          if (y < roofTop(x)) continue;
          const edge = x === RIDGE_L || x === RIDGE_R;
          const dash = (y + (x === RIDGE_L ? 0 : 2)) % 4 < 2;
          let c: Rgb;
          if (edge) c = dash ? KT.line : KT.shade;
          else if (x === RIDGE_L + 1) c = KT.sun;
          else if (x >= RIDGE_R - 2) c = x === RIDGE_R - 1 ? KT.lo : KT.base;
          else {
            const lift = strawClump(x * 1.4, y, seed + 7, 0.7);
            c = lift > 0.3 ? KT.sun : lift > 0 ? KT.hi : KT.light;
          }
          // Its rounded cap at the back, and its end overhanging the gable.
          if (y === RIDGE_TOP && !edge) c = KT.hi;
          if (y >= RIDGE_END - 2)
            c = y === RIDGE_END ? KT.line : y === RIDGE_END - 1 ? KT.lo : mix(c, KT.lo, 0.5);
          b.set(x, y, c);
        }
      }

      // ── The gable: a dark recess with light slats, bargeboards, rafter ends ──
      for (let y = RIDGE_END + 1; y <= GABLE_BASE + 3; y++) {
        for (let x = 0; x < w; x++) {
          if (!inGable(x, y)) continue;
          const d = -gableDist(x, y); // how far inside the edge
          let c: Rgb;
          if (y <= GABLE_BASE) {
            if (d < 1)
              c = KT.line; // bargeboards
            else if (d < 2.2) c = W.deep;
            else if (y < 67)
              c = W.line; // deep under the ridge's end
            else if (y < GABLE_BASE - 1) {
              // Slats: light boards with dark gaps, lit toward the left.
              const slat = (y - 67) % 3;
              c = slat === 0 ? W.deep : slat === 1 ? (x < cx ? KW.lit : KW.board) : KW.dark;
            } else c = y === GABLE_BASE - 1 ? KW.hi : KW.lit; // the tie beam
          } else {
            // Rafter ends under the tie beam.
            c = y === GABLE_BASE + 3 ? KT.line : (x + 1) % 3 === 0 ? W.line : KW.hi;
            if (y === GABLE_BASE + 2 && (x + 1) % 3 !== 0) c = KW.lit;
          }
          b.set(x, y, c);
        }
      }
      // A louvred vent near the top of the gable.
      b.rect(30, 66, 6, 3, W.line);
      for (const vx of [31, 33]) b.rect(vx, 67, 1, 1, KW.seam);

      // ── Moss in the lower hollows of the slopes ──
      const rnd = stream(seed + 9);
      for (let i = 0; i < 16; i++) {
        const mx = Math.round(5 + rnd() * (w - 10));
        const my = Math.round(40 + rnd() * 38);
        const onSlope = (mx < RIDGE_L - 2 || mx > RIDGE_R + 2) && !inGable(mx, my);
        if (onSlope && b.opaque(mx, my)) {
          b.set(mx, my, KT.moss);
          if (rnd() < 0.5) b.set(mx + 1, my, KT.moss);
        }
      }
    },
    { rx: 31, ry: 5, dx: 6, dy: -1, a: 0.32 },
  );
}

/** A doghouse from above: a big pitched roof of boards, a dark arch under it. */
export function kennelTop(): Sprite {
  const w = 30;
  const h = 34;
  return sprite(
    w,
    h,
    15,
    32,
    (b) => {
      // The front: a board face with an arched door.
      b.rect(5, 20, 20, 11, W.warm);
      for (let x = 5; x < 25; x += 4) b.rect(x, 20, 1, 11, W.face);
      b.ellipse(15, 26, 6, 6, W.deep);
      b.rect(9, 26, 13, 5, W.deep);
      b.rect(10, 29, 11, 2, W.face);
      // The roof: two board slopes seen from above, the ridge running back.
      for (let y = 0; y < 22; y++) {
        const half = Math.round(4 + (y / 22) * 11);
        for (let x = 15 - half; x <= 15 + half; x++) {
          const right = x > 15;
          const board = (y + (right ? 0 : 2)) % 4 === 0;
          let c: Rgb = right ? (board ? W.face : W.base) : board ? W.base : W.light;
          if (Math.abs(x - 15) < 1) c = W.hi;
          b.set(x, y, c);
        }
      }
      b.rect(2, 20, 26, 2, W.face);
    },
    { rx: 13, ry: 3, dx: 2, dy: -1, a: 0.3 },
  );
}

/**
 * A wooden water tub from above: its rim and the dark water inside are the
 * biggest part; the green-banded staves show as a short band below, and it
 * stands on a ring of pale stones.
 */
export function tubTop(): Sprite {
  const green = 0x4f9a3a;
  const greenHi = 0x7cc456;
  const greenDark = 0x2f6a24;
  return sprite(
    30,
    34,
    15,
    31,
    (b) => {
      // Stones round its foot.
      for (const [x, y, r] of [
        [5, 27, 4.4],
        [15, 30, 4.8],
        [25, 27, 4.4],
        [9, 31, 3.6],
        [21, 31, 3.6],
      ] as const) {
        b.ellipse(x, y, r * 1.15, r * 0.75, 0xc9c2b9);
        b.ellipse(x - 0.8, y - 0.8, r * 0.7, r * 0.42, 0xe8e2da);
      }
      // The staves: a short green band.
      for (let y = 15; y < 28; y++) {
        for (let x = 4; x < 26; x++) {
          const nx = (x - 15) / 11;
          let c: Rgb = nx < -0.45 ? greenHi : nx > 0.5 ? greenDark : green;
          if ((x - 4) % 4 === 0) c = mix(c, greenDark, 0.45);
          b.set(x, y, c);
        }
      }
      b.rect(3, 19, 24, 1, 0x3a3a26);
      b.rect(3, 25, 24, 1, 0x3a3a26);
      // The top: a thick rim and dark water, an ellipse seen from above.
      b.ellipse(15, 12, 12, 9, 0xb08a3a);
      b.ellipse(15, 11.5, 10, 7, 0x8a6a28);
      b.ellipse(15, 12.5, 9, 6, 0x2c4a40);
      b.ellipse(13, 10.5, 4, 2, 0x4a7a6a);
      b.rect(10, 9, 3, 1, 0x9ad0c0);
    },
    { rx: 12, ry: 3, dx: 1, dy: 0, a: 0.28 },
  );
}

/** One canopy pad: a rounded dome with a lit crown, a dark rim and a ragged, leafy edge. */
function pad(
  b: PixelBuffer,
  cx: number,
  cy: number,
  r: number,
  T: { hi: Rgb; light: Rgb; base: Rgb; dark: Rgb; deep: Rgb },
  seed: number,
): void {
  const ry = r * 0.78;
  for (let y = Math.floor(cy - ry - 2); y <= cy + ry + 2; y++) {
    for (let x = Math.floor(cx - r - 2); x <= cx + r + 2; x++) {
      const dx = (x + 0.5 - cx) / r;
      const dy = (y + 0.5 - cy) / ry;
      // A ragged, leafy rim: small bites taken out of the edge.
      const edge = 1 + (noise(x, y, 1.8, seed) - 0.5) * 0.32;
      if (dx * dx + dy * dy > edge * edge) continue;
      // Light from the top left; the crown is lit, the underside dark.
      const lit = -dx * 0.5 - dy * 0.95 + (noise(x, y, 2.4, seed + 1) - 0.5) * 0.5;
      const rimDist = edge - Math.hypot(dx, dy);
      let c: Rgb =
        lit > 0.6
          ? T.hi
          : lit > 0.2
            ? T.light
            : lit > -0.25
              ? T.base
              : lit > -0.65
                ? T.dark
                : T.deep;
      if (rimDist < 0.12 && dy > -0.2) c = T.deep; // the dark lower rim
      // Leaf clusters: small lighter flecks on the lit half.
      if (lit > 0 && hash(x, y, seed + 3) < 0.06) c = T.hi;
      b.set(x, y, c);
    }
  }
}

/**
 * A shade tree from above, built like the reference's: several canopy pads
 * stacked into a tall, lumpy crown, each pad its own dome, with gnarled
 * branches showing in the gaps between them and a short trunk at the foot.
 */
export function canopyTree(seed: number, tones: "green" | "olive" = "green", size = 1): Sprite {
  const T =
    tones === "olive"
      ? { hi: 0xc4b452, light: 0xa69e3c, base: 0x8a8430, dark: 0x666424, deep: 0x46431a }
      : { hi: 0xa6c64e, light: 0x82aa3c, base: 0x64902e, dark: 0x4a6e22, deep: 0x2e4c16 };
  const R = 11 * size;
  const w = Math.round(R * 4.4);
  const h = Math.round(R * 5.4);
  const rnd = stream(seed);
  return sprite(
    w,
    h,
    Math.round(w / 2),
    h - 3,
    (b) => {
      const cx = w / 2;
      // The trunk and the branches that hold the pads.
      const trunkTop = h - R * 1.6;
      for (let y = Math.round(trunkTop); y < h - 3; y++) {
        const lean = Math.round(Math.sin((y - trunkTop) / 6 + seed) * 1.5);
        for (let x = 0; x < 6; x++) {
          b.set(Math.round(cx - 3) + x + lean, y, x === 0 ? W.light : x > 3 ? W.deep : W.face);
        }
      }
      // Roots splaying out at the foot.
      for (const [dx, len] of [
        [-5, 4],
        [6, 3],
        [-2, 2],
      ] as const) {
        for (let k = 0; k < len; k++)
          b.set(Math.round(cx + dx * (k / len)), h - 4 + Math.min(1, k), W.face);
      }
      // Pads: arranged in tiers, the top of the crown first, the lowest last.
      const pads: Array<[number, number, number]> = [
        [cx + (rnd() - 0.5) * R * 0.6, R * 1.05, R * 0.82],
        [cx - R * 0.95 + rnd() * 3, R * 1.75, R * 0.74],
        [cx + R * 0.95 - rnd() * 3, R * 1.65, R * 0.76],
        [cx + (rnd() - 0.5) * R * 0.4, R * 2.35, R * 0.78],
        [cx - R * 1.15, R * 2.95, R * 0.66],
        [cx + R * 1.1, R * 2.85, R * 0.68],
      ];
      // Branches into each pad, drawn before the pads so they peek through.
      for (const [px, py] of pads) {
        const steps = Math.max(4, Math.round(Math.hypot(px - cx, trunkTop - py) / 1.5));
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          const bx = Math.round(cx + (px - cx) * t);
          const by = Math.round(trunkTop + (py + R * 0.3 - trunkTop) * t);
          b.set(bx, by, W.face);
          b.set(bx + 1, by, W.deep);
        }
      }
      for (const [px, py, r] of pads) pad(b, px, py, r, T, seed + Math.round(px * 3 + py));
    },
    { rx: R * 1.9, ry: R * 0.6, dx: 3, dy: -2, a: 0.32 },
  );
}

/** A low, clipped shrub from above: two or three overlapping pads, a bumpy mound. */
export function moundShrub(
  seed: number,
  tone: "green" | "olive" | "amber" = "green",
  r = 11,
): Sprite {
  const T =
    tone === "olive"
      ? { hi: 0xc4b452, light: 0xa69e3c, base: 0x8a8430, dark: 0x666424, deep: 0x46431a }
      : tone === "amber"
        ? { hi: 0xe2b45c, light: 0xc8923a, base: 0xaa742a, dark: 0x86561c, deep: 0x5e3a12 }
        : { hi: 0xa6c64e, light: 0x82aa3c, base: 0x64902e, dark: 0x4a6e22, deep: 0x2e4c16 };
  const w = Math.round(r * 2.6) + 4;
  const h = Math.round(r * 1.9) + 4;
  const rnd = stream(seed);
  return sprite(
    w,
    h,
    Math.round(w / 2),
    h - 2,
    (b) => {
      const cx = w / 2;
      const cy = h - r * 0.95;
      const lumps = 2 + Math.floor(rnd() * 2);
      pad(b, cx + (rnd() - 0.5) * 2, cy - r * 0.32, r * 0.7, T, seed);
      for (let k = 0; k < lumps; k++) {
        const side = k % 2 === 0 ? -1 : 1;
        pad(
          b,
          cx + side * r * (0.42 + rnd() * 0.15),
          cy + rnd() * r * 0.15,
          r * (0.58 + rnd() * 0.12),
          T,
          seed + k + 1,
        );
      }
    },
    { rx: r + 2, ry: 2.8, dx: 1, dy: -1, a: 0.3 },
  );
}

// ── The rest of the yard, from above ─────────────────────────

const STONE = {
  hi: 0xeee9e2,
  light: 0xd8d2ca,
  base: 0xc1bab1,
  mid: 0xa59d94,
  side: 0x857c73,
  deep: 0x5e564e,
} as const;

/**
 * A side building from above: a low gabled roof of boards weighted down with
 * stones (its two slopes, the ridge running across), a short front of plaster
 * and timber under the eave, and firewood stacked under a lean-to.
 */
export function annexTop(seed: number): Sprite {
  const w = 76;
  const roofH = 40;
  const wallH = 14;
  const h = roofH + wallH + 6;
  return sprite(
    w,
    h,
    40,
    h - 2,
    (b) => {
      const wallTop = roofH - 4;
      // The front: plaster panels between dark posts, a slatted window, a door.
      for (let y = wallTop; y < wallTop + wallH; y++) {
        for (let x = 14; x < w - 4; x++) {
          const post = (x - 14) % 18 < 3;
          b.set(x, y, post ? W.face : y > wallTop + wallH - 4 ? W.base : 0xeedfc4);
        }
      }
      b.rect(22, wallTop + 3, 9, 7, W.deep);
      for (let x = 23; x < 31; x += 2) b.rect(x, wallTop + 3, 1, 7, W.base);
      b.rect(48, wallTop + 2, 12, wallH - 2, 0xd8d0c0);
      b.rect(48, wallTop + 2, 1, wallH - 2, W.face);
      // The lean-to on the left: logs stacked end-on under a small roof.
      for (let row = 0; row < 3; row++) {
        for (let k = 0; k < 3; k++) {
          const lx = 3 + k * 4 + (row % 2) * 2;
          const ly = wallTop + 3 + row * 4;
          b.ellipse(lx + 1.5, ly + 1.5, 2, 2, W.light);
          b.set(lx + 1, ly + 1, W.face);
        }
      }
      // The roof: two board slopes meeting at a ridge across the middle. The
      // back slope is lit (we see more of it), the front slope runs to the eave.
      const ridge = 14;
      for (let y = 0; y < roofH; y++) {
        for (let x = 0; x < w; x++) {
          const front = y > ridge;
          const plank = (x + (front ? 3 : 0)) % 7 === 0;
          const course = (y - (front ? ridge : 0)) % 6 === 0;
          let c: Rgb = front ? (plank ? W.face : W.base) : plank ? W.base : W.light;
          if (course && y > 0) c = W.face;
          if (y === ridge || y === ridge + 1) c = y === ridge ? W.hi : W.deep;
          if (y >= roofH - 3) c = y === roofH - 1 ? W.line : W.face;
          b.set(x, y, c);
        }
      }
      // Stones weighting the boards, each its own shape.
      const rnd = stream(seed);
      for (let i = 0; i < 9; i++) {
        const sx = 6 + i * 8 + Math.round((rnd() - 0.5) * 3);
        const sy = i % 2 === 0 ? 7 + Math.round(rnd() * 3) : 24 + Math.round(rnd() * 5);
        b.ellipse(sx, sy, 3 + rnd(), 2.2, STONE.base);
        b.ellipse(sx - 0.7, sy - 0.8, 1.8, 1, STONE.hi);
        b.set(sx + 1, sy + 1, STONE.side);
      }
    },
    { rx: 34, ry: 5, dx: 4, dy: -2, a: 0.32 },
  );
}

/**
 * A koi pond from above: an irregular basin of jade water ringed with big
 * pale stones (their tops lit, a little of their sides showing below), koi,
 * a lily pad, a bamboo spout pouring in from the edge.
 */
export function pondTop(width: number, height: number, seed: number, koi = true): Sprite {
  const pad = 13;
  const w = width + pad * 2;
  const h = height + pad * 2;
  const cx = w / 2;
  const cy = h / 2;
  const rx = width / 2;
  const ry = height / 2;
  const shape = blob(seed, 0.12, 4);
  return sprite(
    w,
    h,
    Math.round(cx),
    h - 4,
    (b) => {
      // The water: pale jade, deeper in the middle, crossed by light ripple lines.
      const cells: Array<[number, number]> = [];
      const rnd = stream(seed + 40);
      for (let i = 0; i < 10; i++)
        cells.push([cx + (rnd() - 0.5) * rx * 1.7, cy + (rnd() - 0.5) * ry * 1.7]);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const nx = (x + 0.5 - cx) / rx;
          const ny = (y + 0.5 - cy) / ry;
          if (!shape(nx, ny)) continue;
          let near = Infinity;
          let next = Infinity;
          for (const [px, py] of cells) {
            const d = Math.hypot(x + 0.5 - px, (y + 0.5 - py) * 1.25);
            if (d < near) {
              next = near;
              near = d;
            } else if (d < next) next = d;
          }
          const depth = nx * nx + ny * ny;
          let c: Rgb = depth < 0.4 ? 0x7cc8c4 : 0x9ee0d8;
          if (next - near < 1.1) c = 0xd6f5ef;
          if (ny < -0.62) c = 0x5fa8a8; // the stones' shade on the far water
          b.set(x, y, c);
        }
      }
      // Koi (left out when the live view swims them itself).
      if (koi) {
        const fx = Math.round(cx - 6);
        const fy = Math.round(cy + 3);
        b.rect(fx, fy, 7, 2, 0xe8742a);
        b.set(fx - 1, fy - 1, 0xe8742a);
        b.set(fx - 1, fy + 2, 0xe8742a);
        b.set(fx + 3, fy, 0xffffff);
        b.rect(Math.round(cx + 6), Math.round(cy - 4), 2, 6, 0xe8742a);
        b.set(Math.round(cx + 6), Math.round(cy - 2), 0xffffff);
      }
      b.ellipse(cx + 10, cy + 5, 2.8, 2, 0x6a9a2a);
      b.set(Math.round(cx + 10), Math.round(cy + 5), 0x9ccc4a);
      // The stone ring: back stones first so front ones overlap them.
      const count = Math.round((rx + ry) * 0.36);
      const ring: Array<[number, number, number]> = [];
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + hash(i, 1, seed) * 0.2;
        const r = 6.4 + hash(i, 0, seed) * 2.6;
        ring.push([cx + Math.cos(a) * (rx + 3), cy + Math.sin(a) * (ry + 3), r]);
      }
      ring.sort((p, q) => p[1] - q[1]);
      for (const [sx, sy, r] of ring) {
        const sh = blob(Math.round(sx * 13 + sy * 7), 0.18, 4);
        for (let y = Math.floor(sy - r); y <= sy + r + 3; y++) {
          for (let x = Math.floor(sx - r * 1.2); x <= sx + r * 1.2; x++) {
            const nx = (x + 0.5 - sx) / (r * 1.2);
            const top = sh(nx, (y + 0.5 - sy) / (r * 0.78));
            const side = !top && sh(nx, (y + 0.5 - sy - 2.5) / (r * 0.78));
            if (!top && !side) continue;
            if (side) {
              b.set(x, y, STONE.side);
              continue;
            }
            const ny = (y + 0.5 - sy) / (r * 0.78);
            const lit = -nx * 0.45 - ny * 0.85;
            b.set(
              x,
              y,
              lit > 0.55 ? STONE.hi : lit > 0.1 ? STONE.light : lit > -0.4 ? STONE.base : STONE.mid,
            );
          }
        }
      }
    },
    undefined,
  );
}

/**
 * A torii from above: the two black-capped crossbeams seen mostly from their
 * tops (wide, lit bars), the red pillars short beneath, standing on stones.
 */
export function toriiTop(): Sprite {
  const w = 50;
  const h = 36;
  const red = 0xc8442c;
  const redLit = 0xe0664a;
  const redDark = 0x8a2a1c;
  return sprite(
    w,
    h,
    25,
    34,
    (b) => {
      // Pillars: short, round, lit on the left, on stone footings.
      for (const px of [10, 36]) {
        for (let y = 12; y < 32; y++) {
          for (let x = 0; x < 5; x++) b.set(px + x, y, x === 0 ? redLit : x > 3 ? redDark : red);
        }
        b.rect(px - 1, 31, 7, 3, STONE.base);
        b.rect(px - 1, 31, 7, 1, STONE.hi);
      }
      // The lower beam (nuki): a red bar seen from slightly above.
      b.rect(6, 14, w - 12, 4, red);
      b.rect(6, 14, w - 12, 1, redLit);
      b.rect(6, 17, w - 12, 1, redDark);
      // The plaque between the beams.
      b.rect(22, 9, 7, 7, 0x2a1a10);
      b.rect(23, 10, 5, 5, 0xe8c44a);
      // The top beam (kasagi): a wide black cap with upswept ends, its top lit.
      for (let x = 0; x < w; x++) {
        const rise = x < 4 ? 4 - x : x >= w - 4 ? x - (w - 5) : 0;
        b.rect(x, 2 - Math.round(rise * 0.6), 1, 3, 0x2a2420);
        b.set(x, 2 - Math.round(rise * 0.6), 0x55504a);
        b.rect(x, 5 - Math.round(rise * 0.6), 1, 3, red);
        b.set(x, 7 - Math.round(rise * 0.6), redDark);
      }
    },
    { rx: 18, ry: 3, dx: 2, dy: -1, a: 0.28 },
  );
}

/** A stone lantern from above: a broad roof cap (mostly its top), the lit box, a post. */
export function lanternTop(): Sprite {
  return sprite(
    20,
    28,
    10,
    26,
    (b) => {
      // Base and post.
      b.ellipse(10, 24, 7, 3, STONE.mid);
      b.ellipse(10, 23.4, 6, 2.2, STONE.base);
      b.rect(8, 15, 5, 8, STONE.base);
      b.rect(8, 15, 1, 8, STONE.hi);
      b.rect(11, 15, 2, 8, STONE.mid);
      // The firebox: a lit window glowing warm.
      b.rect(6, 10, 9, 6, STONE.light);
      b.rect(8, 11, 5, 4, 0xffcf6a);
      b.rect(8, 11, 5, 1, 0xfff0b0);
      b.rect(6, 15, 9, 1, STONE.side);
      // The roof: a wide cap seen from above, with a knob.
      b.ellipse(10, 7, 9, 4, STONE.mid);
      b.ellipse(10, 6, 8.4, 3.4, STONE.base);
      b.ellipse(9, 5, 5.5, 2, STONE.light);
      b.ellipse(10, 2.5, 2, 1.6, STONE.base);
      b.set(9, 1, STONE.hi);
    },
    { rx: 7, ry: 2, dx: 1, dy: 0, a: 0.28 },
  );
}

/** A bamboo spout from above: the long culm reaching over the water, on its post. */
export function spoutTop(): Sprite {
  const bam = 0xb8c45a;
  const bamLit = 0xd8e07a;
  const bamDark = 0x7f8f2c;
  return sprite(
    30,
    20,
    6,
    18,
    (b) => {
      // The post it rests on, seen from above as a short round cap.
      b.ellipse(6, 15, 3, 2, bamDark);
      b.rect(4, 8, 4, 8, bam);
      b.rect(4, 8, 1, 8, bamLit);
      b.ellipse(6, 8, 2.4, 1.4, bamLit);
      // The culm, angled out over the water, with its nodes.
      for (let i = 0; i < 24; i++) {
        const x = 6 + i;
        const y = Math.round(9 + i * 0.12);
        b.set(x, y - 1, bamLit);
        b.set(x, y, i % 6 === 5 ? bamDark : bam);
        b.set(x, y + 1, bamDark);
      }
      // A thread of water falling from its mouth.
      for (let y = 12; y < 18; y++) b.set(29, y, 0xd6f5ef, 0.8);
    },
    undefined,
  );
}

/**
 * A tea bench under a parasol, from above: the red parasol is the biggest
 * thing (a round canopy, lit on its left half), the bench's red cloth and a
 * tea tray peeking out below it.
 */
export function teaBenchTop(): Sprite {
  const w = 44;
  const h = 40;
  return sprite(
    w,
    h,
    22,
    38,
    (b) => {
      // The bench: a red-clothed seat seen from above, its legs short below.
      b.rect(5, 28, 34, 7, 0xc8442c);
      b.rect(5, 28, 34, 1, 0xe8705a);
      b.rect(5, 34, 34, 1, 0x8a2a1c);
      for (const x of [7, 35]) b.rect(x, 35, 2, 3, W.face);
      // The tray: cups and a pot on it.
      b.rect(27, 26, 10, 4, W.light);
      b.ellipse(30, 26, 1.6, 1.2, 0xe8e2d4);
      b.ellipse(34, 26, 1.6, 1.2, 0xe8e2d4);
      // The parasol: a big round canopy of panels, seen from above.
      const cx = 18;
      const cy = 13;
      for (let y = 0; y < 28; y++) {
        for (let x = 0; x < w; x++) {
          const dx = (x + 0.5 - cx) / 17;
          const dy = (y + 0.5 - cy) / 11;
          const d = dx * dx + dy * dy;
          if (d > 1) continue;
          const panel = Math.floor(((Math.atan2(dy, dx) + Math.PI) / (Math.PI * 2)) * 10) % 2 === 0;
          const lit = -dx * 0.5 - dy * 0.6;
          let c: Rgb = lit > 0.25 ? 0xe8604a : lit > -0.25 ? 0xc8442c : 0x9a301e;
          if (panel && c !== 0x9a301e) c = mix(c, 0x9a301e, 0.2);
          if (d > 0.86) c = 0x8a2a1c;
          b.set(x, y, c);
        }
      }
      b.ellipse(cx, cy, 2, 1.4, 0x5a1a10);
      b.set(cx - 1, cy - 1, 0xe8705a);
    },
    { rx: 16, ry: 3, dx: 2, dy: -1, a: 0.28 },
  );
}

/**
 * A carpenter's bench from above: its wide top (planks, a plane, shavings, a
 * saw) is most of it; its front and legs show as a short band below.
 */
export function benchTop(): Sprite {
  const w = 36;
  const h = 24;
  return sprite(
    w,
    h,
    18,
    22,
    (b) => {
      // Legs and front, a short band.
      b.rect(2, 15, 32, 3, W.face);
      for (const x of [3, 30]) b.rect(x, 18, 3, 4, W.deep);
      // The top: planks running along.
      for (let y = 4; y < 15; y++) {
        for (let x = 1; x < 35; x++) {
          b.set(x, y, y % 4 === 0 ? W.base : y === 5 ? W.hi : x < 6 ? W.light : W.warm);
        }
      }
      // A plank being planed, the plane, curled shavings, a saw.
      b.rect(6, 6, 18, 4, 0xe8c48a);
      b.rect(6, 6, 18, 1, 0xf6dcae);
      b.rect(15, 5, 6, 3, W.face);
      b.rect(16, 4, 2, 1, 0xa9a29a);
      for (const [x, y] of [
        [26, 7],
        [28, 10],
        [25, 11],
        [9, 12],
      ] as const) {
        b.set(x, y, 0xf6dcae);
        b.set(x + 1, y, 0xe8c48a);
      }
      b.rect(27, 4, 7, 2, 0xc9c2b9);
      b.rect(32, 4, 2, 3, W.face);
    },
    { rx: 16, ry: 2.5, dx: 1, dy: 0, a: 0.28 },
  );
}

/**
 * A kamado (clay stove) from above: its top shows two round pots in their
 * holes, the clay body below with the fire's mouth glowing.
 */
export function stoveTop(): Sprite {
  const clay = 0xb87a4a;
  const clayLit = 0xd89a62;
  const clayDark = 0x8a5230;
  return sprite(
    34,
    30,
    17,
    28,
    (b) => {
      // The body's front: clay, with the fire's mouth.
      b.rect(2, 14, 30, 12, clay);
      b.rect(2, 14, 2, 12, clayLit);
      b.rect(28, 14, 4, 12, clayDark);
      b.ellipse(11, 22, 4, 3.4, 0x3a1a0a);
      b.ellipse(11, 23, 2.6, 2, 0xff8a2a);
      b.set(10, 22, 0xffe08a);
      b.ellipse(24, 22, 4, 3.4, 0x3a1a0a);
      b.ellipse(24, 23, 2, 1.6, 0xc84a1a);
      // The top: the clay slab with two pots sitting in it.
      b.rect(1, 4, 32, 11, clayLit);
      b.rect(1, 4, 32, 1, 0xf0b47a);
      for (const [px, lid] of [
        [10, true],
        [24, false],
      ] as const) {
        b.ellipse(px, 9, 6, 4, 0x2a2420);
        b.ellipse(px, 8.5, 5, 3.2, lid ? 0x5a4a3a : 0x3a3430);
        if (lid) {
          b.ellipse(px - 1, 7.5, 2.4, 1.2, 0x8a7a64);
          b.set(px, 7, 0xc8b89a);
        } else b.ellipse(px, 8.5, 3.6, 2.2, 0xe8e2d4); // rice steaming
      }
    },
    { rx: 15, ry: 2.6, dx: 1, dy: 0, a: 0.28 },
  );
}

/**
 * A notes board under a small roof, from above: the roof (two board slopes)
 * is most of it, the board with its pinned notes shows below the eave.
 */
export function notesBoardTop(seed: number): Sprite {
  const w = 32;
  const h = 34;
  return sprite(
    w,
    h,
    16,
    32,
    (b) => {
      for (const x of [5, 25]) b.rect(x, 12, 2, 20, W.face);
      // The board: cork, with notes pinned up.
      b.rect(4, 14, 24, 13, 0xb08a52);
      b.rect(4, 14, 24, 1, 0xd2ac70);
      const rnd = stream(seed);
      const colours = [0xfff1d8, 0xf6d24a, 0xf2b6c6, 0xbfe0f0, 0xfff1d8];
      for (let i = 0; i < 5; i++) {
        const nx = 6 + (i % 3) * 7 + Math.round(rnd() * 2);
        const ny = 16 + Math.floor(i / 3) * 5 + Math.round(rnd() * 2);
        b.rect(nx, ny, 5, 4, colours[i] ?? 0xfff1d8);
        b.set(nx + 2, ny, 0xc8442c);
        b.rect(nx + 1, ny + 2, 3, 1, 0x8a7a64);
      }
      // The little roof: two board slopes, the ridge across.
      for (let y = 0; y < 13; y++) {
        for (let x = 0; x < w; x++) {
          const front = y > 4;
          let c: Rgb = front
            ? (x + 1) % 4 === 0
              ? W.face
              : W.base
            : x % 4 === 0
              ? W.base
              : W.light;
          if (y === 4) c = W.hi;
          if (y >= 11) c = y === 12 ? W.line : W.face;
          b.set(x, y, c);
        }
      }
    },
    { rx: 14, ry: 2.4, dx: 2, dy: -1, a: 0.28 },
  );
}

/** A red post box from above: its domed top is most of it, the slot below. */
export function postBoxTop(): Sprite {
  return sprite(
    16,
    24,
    8,
    22,
    (b) => {
      b.rect(3, 9, 10, 12, 0xc8442c);
      b.rect(3, 9, 2, 12, 0xe0664a);
      b.rect(11, 9, 2, 12, 0x8a2a1c);
      b.rect(5, 12, 6, 2, 0x2a1a10);
      b.rect(5, 16, 6, 3, 0xfff1d8);
      b.ellipse(8, 7, 6, 4, 0xc8442c);
      b.ellipse(7, 6, 4, 2.4, 0xe8705a);
      b.set(6, 5, 0xfbb0a0);
      b.rect(6, 21, 4, 2, 0x5a5048);
    },
    { rx: 5, ry: 1.8, dx: 1, dy: 0, a: 0.28 },
  );
}

/**
 * A campfire from above: a ring of stones round the pit, logs crossed in the
 * middle, flames rising from them, a kettle on its tripod.
 */
export function fireTop(flames = true): Sprite {
  const w = 34;
  const h = 36;
  return sprite(
    w,
    h,
    17,
    33,
    (b) => {
      // The ring: stones around an oval pit, seen from above.
      const cx = 17;
      const cy = 26;
      b.ellipse(cx, cy, 11, 6, 0x3a2a20);
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        const sx = cx + Math.cos(a) * 11;
        const sy = cy + Math.sin(a) * 6;
        b.ellipse(sx, sy, 3.4, 2.4, STONE.base);
        b.ellipse(sx - 0.8, sy - 0.8, 2, 1.2, STONE.hi);
        b.set(Math.round(sx + 1), Math.round(sy + 1.5), STONE.side);
      }
      // Logs crossed in the pit, glowing at their ends.
      for (let k = 0; k < 9; k++) {
        b.set(cx - 6 + k, cy - 1 + Math.round(k * 0.3), W.face);
        b.set(cx + 6 - k, cy - 1 + Math.round(k * 0.3), W.base);
      }
      b.ellipse(cx, cy, 4, 2, 0xff8a2a);
      b.ellipse(cx, cy - 0.5, 2.4, 1.2, 0xffd060);
      // Flames: a tall core and two licks (the live view flickers its own).
      for (let y = 0; y < (flames ? 12 : 0); y++) {
        const t = y / 12;
        const half = Math.round((1 - t) * 4);
        for (let x = cx - half; x <= cx + half; x++) {
          b.set(
            x,
            cy - 2 - y,
            t > 0.6 ? 0xffd060 : Math.abs(x - cx) < half - 1 ? 0xffe8a0 : 0xff8a2a,
          );
        }
      }
      // The tripod and kettle, standing over the fire.
      for (let k = 0; k < 14; k++) {
        b.set(cx - 9 + Math.round(k * 0.6), cy - k, W.deep);
        b.set(cx + 9 - Math.round(k * 0.6), cy - k, W.deep);
      }
      b.ellipse(cx, 9, 5, 3.6, 0x2a2420);
      b.ellipse(cx - 1, 8, 3, 1.6, 0x5a5048);
      b.rect(cx - 1, 2, 2, 5, W.deep);
    },
    { rx: 12, ry: 3, dx: 1, dy: 0, a: 0.25 },
  );
}
