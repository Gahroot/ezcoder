// Detailed farm art for the cosy top-down Goal world, drawn pixel by pixel
// to sit beside hand-made farm-sim art: stepping stones that are each their
// own shape, crops where every plant grows its own way (each with its own
// outline, so they read as chunky little plants), raised beds with depth, a
// farmhouse whose every bay is different, and the small things that make a
// yard feel lived in. Pure: the same seed always draws the same pixels.

import { PixelBuffer, hash, mix, noise, stream, type Rgb } from "./goal-map-pixels";
import type { Sprite } from "./goal-map-props";

/** The warm near-black every edge in this world is drawn in. */
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

/** An irregular closed shape: its radius wobbles smoothly with the angle. */
export function blob(seed: number, wobble = 0.16, lobes = 4): (nx: number, ny: number) => boolean {
  const amps: number[] = [];
  const phases: number[] = [];
  for (let k = 0; k < lobes; k++) {
    amps.push((0.45 + hash(k, 1, seed) * 0.55) / (k + 1));
    phases.push(hash(k, 2, seed) * Math.PI * 2);
  }
  return (nx, ny) => {
    const a = Math.atan2(ny, nx);
    let r = 1;
    for (let k = 0; k < lobes; k++)
      r += wobble * (amps[k] ?? 0) * Math.sin((k + 2) * a + (phases[k] ?? 0));
    return Math.hypot(nx, ny) <= r;
  };
}

// ── Stones ───────────────────────────────────────────────────

const ST = {
  sheen: 0xf6f3ee,
  light: 0xe2dcd4,
  base: 0xc9c2b9,
  mid: 0xb0a89f,
  side: 0x8d847b,
  deep: 0x625951,
  moss: 0x9cb344,
} as const;

/**
 * A flat stepping stone, read from a hand-drawn one: a wide, irregular slab
 * seen from above, almost all one pale warm grey (no highlights on its face,
 * it is flat), a darker grey belly in its lower third, a dark-grey lip along
 * the bottom where its edge shows, a couple of white glints on its rim, and a
 * thin dark outline. Each one has its own outline. Big ones for the path.
 */
export function stone(seed: number, size: "s" | "m" | "l" = "m", mossy = false): Sprite {
  const base = size === "s" ? 5 : size === "l" ? 8.8 : 8.2;
  const rx = base + hash(seed, 0, 3) * 0.9;
  const ry = rx * (0.5 + hash(seed, 1, 3) * 0.06);
  const lip = size === "s" ? 1 : 2;
  const shape = blob(seed, 0.12, 5);
  const w = Math.ceil(rx * 2.3) + 4;
  const h = Math.ceil(ry * 2.3) + lip + 4;
  const cx = w / 2;
  const cy = (h - lip) / 2;
  const at = (x: number, y: number, yOff = 0): boolean =>
    shape((x + 0.5 - cx) / rx, (y + 0.5 - cy - yOff) / ry);
  const SLAB = { face: 0xd1c8bf, belly: 0xb4aea8, lip: 0x6a655e, glint: 0xfdfcf9, moss: 0x7a9a2a };
  return sprite(
    w,
    h,
    Math.round(cx),
    h - 2,
    (b) => {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const top = at(x, y);
          const side = !top && (at(x, y, 1) || (lip > 1 && at(x, y, 2)));
          if (!top && !side) continue;
          if (side) {
            b.set(x, y, SLAB.lip);
            continue;
          }
          const ny = (y + 0.5 - cy) / ry;
          let c: Rgb = ny > 0.42 ? SLAB.belly : SLAB.face;
          // A soft step between face and belly, not a hard line.
          if (ny > 0.3 && ny <= 0.42 && hash(x, y, seed + 2) < 0.4) c = SLAB.belly;
          if (mossy && ny > 0.4 && hash(x >> 1, y, seed + 4) < 0.3) c = SLAB.moss;
          b.set(x, y, c);
        }
      }
      // White glints where the rim catches the light: the top-left and the bottom.
      const rnd = stream(seed + 6);
      const glints = size === "s" ? 1 : 2 + Math.floor(rnd() * 2);
      for (let k = 0; k < glints; k++) {
        const ang = k === 0 ? Math.PI * (1.15 + rnd() * 0.25) : Math.PI * (0.25 + rnd() * 0.5);
        const gx = Math.round(cx + Math.cos(ang) * (rx - 2.2));
        const gy = Math.round(cy + Math.sin(ang) * (ry - 1.6));
        const len = 2 + Math.floor(rnd() * 3);
        for (let d = 0; d < len; d++) if (at(gx + d, gy)) b.set(gx + d, gy, SLAB.glint);
      }
    },
    { rx: rx * 0.85, ry: 1.4, dx: 0, dy: 1, a: 0.16 },
    0.9,
  );
}

// ── Plants (each drawn and outlined on its own) ───────────────

const LEAF = { deep: 0x2f5014, dark: 0x467a1c, base: 0x63992a, light: 0x8cbf3c, hi: 0xb5dc5a };
const DAIKON_LEAF = { dark: 0x4e7a1c, base: 0x78a832, light: 0xa4cc4a, hi: 0xcce06a };

export type Crop = "carrot" | "daikon" | "cabbage" | "rice" | "eggplant";

/** How grown a plant is: 0 a seedling, 1 ready to pull. */
type Stage = number;

/** A short, thick leaf stroke from (x, y) at angle `a`, `len` long. */
function leafStroke(
  b: PixelBuffer,
  x: number,
  y: number,
  a: number,
  len: number,
  tones: { dark: Rgb; base: Rgb; light: Rgb; hi: Rgb },
  broad = 1,
): void {
  for (let s = 0; s <= len; s++) {
    const t = s / len;
    const px = x + Math.cos(a) * s;
    const py = y + Math.sin(a) * s;
    const width = t < 0.2 ? 0 : t > 0.88 ? 0 : broad;
    for (let k = -width; k <= width; k++) {
      const ox = Math.round(px + k * -Math.sin(a));
      const oy = Math.round(py + k * Math.cos(a));
      b.set(ox, oy, k < 0 ? tones.light : k > 0 ? tones.dark : t > 0.7 ? tones.hi : tones.base);
    }
  }
}

function carrotPlant(seed: number, stage: Stage): Sprite {
  return sprite(
    16,
    19,
    8,
    17,
    (b) => {
      const rnd = stream(seed);
      const leaves = stage > 0.7 ? 6 : stage > 0.35 ? 4 : 2;
      const reach = stage > 0.7 ? 8.5 : stage > 0.35 ? 6 : 3.5;
      // Feathery fronds, fanned upward, each ending in a bushy tuft.
      for (let i = 0; i < leaves; i++) {
        const a = -Math.PI / 2 + (i - (leaves - 1) / 2) * 0.36 + (rnd() - 0.5) * 0.3;
        const len = reach + rnd() * 2;
        leafStroke(b, 8, 13, a, len, LEAF, 0);
        const tx = Math.round(8 + Math.cos(a) * len);
        const ty = Math.round(13 + Math.sin(a) * len);
        b.ellipse(tx + 0.5, ty + 0.5, 2.2, 1.8, LEAF.light);
        b.set(tx, ty - 1, LEAF.hi);
        b.set(tx - 1, ty, LEAF.hi);
        if (rnd() < 0.22) b.set(tx + 1, ty, 0xd8c85a); // one leaf turning yellow
      }
      if (stage > 0.3) {
        // The orange shoulder standing up out of the soil.
        const rw = stage > 0.7 ? 3.2 : 2.4;
        b.ellipse(8.5, 15, rw, 2.6, 0xe0702a);
        b.rect(7, 13, 2, 1, 0xf4a058);
        b.set(6, 14, 0xf4a058);
        b.set(Math.round(8 + rw) - 1, 16, 0xb04e18);
        b.set(9, 17, 0xb04e18);
        b.set(7, 16, 0xe88a3a);
      }
    },
    undefined,
    0.82,
  );
}

function daikonPlant(seed: number, stage: Stage): Sprite {
  return sprite(
    16,
    16,
    8,
    14,
    (b) => {
      const rnd = stream(seed);
      const leaves = stage > 0.6 ? 6 : stage > 0.3 ? 5 : 3;
      const reach = stage > 0.6 ? 7.5 : stage > 0.3 ? 5.5 : 3.5;
      // A rosette of broad leaves, back ones first.
      const angles = Array.from(
        { length: leaves },
        (_, i) => -Math.PI / 2 + (i - (leaves - 1) / 2) * 0.6 + (rnd() - 0.5) * 0.25,
      ).sort((p, q) => Math.abs(q + Math.PI / 2) - Math.abs(p + Math.PI / 2));
      for (const a of angles) leafStroke(b, 8, 11, a, reach + rnd() * 1.5, DAIKON_LEAF, 1);
      if (stage > 0.25) {
        // The white root's crown, with a pale green collar.
        const rw = stage > 0.6 ? 3.4 : 2.4;
        b.ellipse(8.5, 12.5, rw, 2, 0xf2efe0);
        b.set(7, 11, 0xffffff);
        b.set(Math.round(8 + rw) - 1, 13, 0xcfc9b0);
        b.rect(7, 10, 3, 1, 0xd6e4a0);
      }
    },
    undefined,
    0.8,
  );
}

function cabbagePlant(seed: number, stage: Stage): Sprite {
  return sprite(
    14,
    13,
    7,
    11,
    (b) => {
      const rnd = stream(seed);
      const r = 2.6 + stage * 2.4;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + rnd() * 0.5;
        b.ellipse(
          7 + Math.cos(a) * r * 0.55,
          7 + Math.sin(a) * r * 0.4,
          r * 0.55,
          r * 0.42,
          Math.sin(a) > 0.2 ? LEAF.dark : LEAF.base,
        );
      }
      b.ellipse(7.2, 6.5, r * 0.62, r * 0.5, 0xb8d47a);
      b.ellipse(6.4, 5.8, r * 0.3, r * 0.22, 0xdcebb0);
      b.set(Math.round(7 + r * 0.3), 8, 0x8cb050);
    },
    undefined,
    0.8,
  );
}

function eggplantPlant(seed: number, stage: Stage): Sprite {
  return sprite(
    14,
    16,
    7,
    14,
    (b) => {
      const rnd = stream(seed);
      for (let i = 0; i < 4; i++) {
        const a = -Math.PI / 2 + (i - 1.5) * 0.7 + (rnd() - 0.5) * 0.2;
        leafStroke(b, 7, 12, a, 4.5 + rnd() * 1.5, LEAF, 1);
      }
      if (stage > 0.4) {
        b.ellipse(5, 12, 1.6, 2.4, 0x5a2a6a);
        b.set(4, 11, 0x8a5aa0);
        if (stage > 0.7) {
          b.ellipse(9.5, 12.5, 1.5, 2.2, 0x6a3a7a);
          b.set(9, 11, 0x9a6ab0);
        }
      }
    },
    undefined,
    0.8,
  );
}

function riceClump(seed: number, stage: Stage): Sprite {
  return sprite(
    14,
    18,
    7,
    16,
    (b) => {
      const rnd = stream(seed);
      const stalks = 6 + Math.floor(rnd() * 4);
      for (let i = 0; i < stalks; i++) {
        const bx = 7 + (i - (stalks - 1) / 2) * 0.9 + (rnd() - 0.5);
        const hgt = 9 + Math.round(rnd() * 4 + stage * 2);
        const lean = (rnd() - 0.5) * 0.4 + (i - stalks / 2) * 0.1;
        let px = bx;
        for (let k = 0; k < hgt; k++) {
          px += lean * 0.28;
          const t = k / hgt;
          b.set(Math.round(px), 15 - k, t < 0.35 ? 0x5e8a28 : t < 0.65 ? 0x9ab840 : 0xd2c454);
        }
        // A drooping golden head.
        const dir = lean >= 0 ? 1 : -1;
        const hx = Math.round(px);
        const hy = 15 - hgt;
        b.set(hx, hy, 0xf0d870);
        b.set(hx + dir, hy, 0xe2c254);
        b.set(hx + dir, hy + 1, 0xd2a838);
        b.set(hx + dir * 2, hy + 2, 0xc89a30);
      }
    },
    undefined,
    0.82,
  );
}

const PLANTS: Readonly<Record<Crop, (seed: number, stage: Stage) => Sprite>> = {
  carrot: carrotPlant,
  daikon: daikonPlant,
  cabbage: cabbagePlant,
  eggplant: eggplantPlant,
  rice: riceClump,
};

// ── Beds and fields ──────────────────────────────────────────

/** A low wooden fence: posts of slightly different heights, two lit rails. */
function fence(b: PixelBuffer, x: number, y: number, width: number, seed: number): void {
  for (const ry of [y + 3, y + 7]) {
    for (let xx = x; xx < x + width; xx++) {
      b.set(xx, ry, hash(xx >> 2, ry, seed) < 0.1 ? 0xdea260 : 0xc98149);
      b.set(xx, ry + 1, 0x8a4e22);
    }
  }
  const posts = Math.max(2, Math.round(width / 11));
  for (let i = 0; i <= posts; i++) {
    const px = Math.min(x + width - 3, Math.round(x + (i * (width - 3)) / posts));
    const ph = 10 + (hash(px, 0, seed) < 0.35 ? 1 : 0);
    const top = y + 11 - ph;
    for (let k = 0; k < ph; k++) {
      b.set(px, top + k, 0xdea260);
      b.set(px + 1, top + k, 0xc98149);
      b.set(px + 2, top + k, 0x8a4e22);
    }
    b.set(px + 1, top, 0xf0c080);
  }
}

/**
 * A raised bed: soil with a lighter, raised rim, furrows between the rows,
 * the bed's front face showing its depth, plants (each different, back rows
 * first so front plants overlap them), and a fence along the front.
 */
export function raisedBed(
  kind: Crop,
  cols: number,
  rows: number,
  seed: number,
  fenced = true,
): Sprite {
  const rice = kind === "rice";
  const cellW = rice ? 13 : 17;
  const cellH = rice ? 14 : 16;
  const bedW = cols * cellW + 8;
  const soilH = rows * cellH + 8;
  const face = 3;
  const headroom = 10;
  const fenceH = fenced ? 12 : 0;
  const w = bedW + 4;
  const h = headroom + soilH + face + fenceH + 1;
  const soil = rice
    ? {
        top: 0x9a7432,
        rim: 0xc49a50,
        furrow: 0x76561f,
        ridge: 0xb08a42,
        face: 0x5e421a,
        lip: 0x8a6a30,
      }
    : {
        top: 0x6e3e16,
        rim: 0x9a6230,
        furrow: 0x4a2208,
        ridge: 0x95602a,
        face: 0x3e1e08,
        lip: 0x7a4a1c,
      };
  const x0 = 2;
  const y0 = headroom;
  const buf = new PixelBuffer(w, h);
  // Soil, rounded corners, a raised rim catching the light along the top and left.
  for (let y = 0; y < soilH; y++) {
    for (let x = 0; x < bedW; x++) {
      const cr = 3;
      const cxp = x < cr ? cr - x : x >= bedW - cr ? x - (bedW - cr - 1) : 0;
      const cyp = y < cr ? cr - y : y >= soilH - cr ? y - (soilH - cr - 1) : 0;
      if (cxp * cxp + cyp * cyp > cr * cr) continue;
      const edge =
        x === 0 ||
        y === 0 ||
        x === bedW - 1 ||
        y === soilH - 1 ||
        cxp * cxp + cyp * cyp > (cr - 1) ** 2;
      const r = (y - 4 + cellH * 4) % cellH;
      let c: Rgb = soil.top;
      if (r >= cellH - 2) c = soil.furrow;
      else if (r <= 1) c = soil.ridge;
      if (hash(x, y, seed + 3) < 0.035) c = mix(c, soil.ridge, 0.7);
      if (rice && noise(x, y, 4, seed) > 0.8) c = 0xb8c8a0; // water in the paddy
      // A thick earth rim around the bed, lit along the top.
      const rim = x <= 2 || y <= 2 || x >= bedW - 3 || y >= soilH - 2;
      if (rim)
        c =
          y <= 2
            ? soil.rim
            : x <= 2
              ? mix(soil.rim, soil.top, 0.3)
              : mix(soil.rim, soil.face, 0.55);
      if (edge)
        c = y <= 1 || x <= 1 ? mix(soil.rim, 0xffffff, 0.12) : mix(soil.rim, soil.face, 0.5);
      buf.set(x0 + x, y0 + y, c);
    }
  }
  for (let y = 0; y < face; y++) {
    for (let x = 2; x < bedW - 2; x++)
      buf.set(x0 + x, y0 + soilH + y, y === 0 ? soil.lip : soil.face);
  }
  buf.outline(0.86, LINE);
  // Plants, back row first. Each is its own plant: its own growth, lean and leaves.
  const plant = PLANTS[kind];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const rnd = stream(seed * 131 + r * 17 + c * 7);
      const roll = rnd();
      if (roll < 0.05) continue;
      const stage = roll < 0.16 ? 0.2 : roll < 0.4 ? 0.5 : 0.92;
      const p = plant(seed * 977 + r * 31 + c * 13, stage);
      // Staggered rows, the way hand-sown beds are laid out.
      const stagger = r % 2 === 1 && !rice ? Math.round(cellW / 2) - 2 : 0;
      if (stagger && c === cols - 1) continue;
      const px =
        x0 + 5 + c * cellW + Math.round(cellW / 2) + stagger + Math.round((rnd() - 0.5) * 2);
      const py = y0 + 5 + r * cellH + Math.round(cellH * 0.7) + Math.round((rnd() - 0.5) * 2);
      buf.draw(p.buf, px - p.ax, py - p.ay, rnd() < 0.5);
    }
  }
  if (fenced) fence(buf, 1, h - fenceH - 1, w - 2, seed);
  return {
    buf,
    ax: Math.round(w / 2),
    ay: h - 2,
    shadow: { rx: w / 2, ry: 2.5, dx: 1, dy: 0, a: 0.22 },
  };
}

/** Long, rounded rows of a clipped crop (tea, or young cabbage), each a little different. */
export function teaRows(width: number, rolls: number, seed: number): Sprite {
  const rollH = 11;
  const gap = 3;
  const h = rolls * (rollH + gap) + 6;
  const w = width + 6;
  const buf = new PixelBuffer(w, h);
  buf.rect(1, 3, w - 2, h - 5, 0x6e3e16);
  for (let x = 1; x < w - 1; x++) buf.set(x, 3, 0x9a6230);
  buf.outline(0.86, LINE);
  for (let r = 0; r < rolls; r++) {
    const roll = new PixelBuffer(w, rollH + 2);
    const inset = 2 + Math.round(hash(r, 0, seed) * 4);
    const right = w - 3 - Math.round(hash(r, 1, seed) * 4);
    for (let y = 0; y < rollH; y++) {
      const half = rollH / 2;
      const endR = half * Math.sqrt(Math.max(0, 1 - ((y - half + 0.5) / half) ** 2));
      for (let x = inset; x < right; x++) {
        if (x < inset + half - endR || x > right - half + endR) continue;
        const t = y / rollH;
        const bump = noise(x, y, 2, seed + r * 7) - 0.5;
        const l = (0.45 - t) * 1.5 + bump * 0.7 - ((x - inset) / (right - inset)) * 0.25;
        const c =
          l > 0.45
            ? 0xc8e06a
            : l > 0.1
              ? 0xa2c84a
              : l > -0.3
                ? 0x7fae38
                : l > -0.6
                  ? 0x5a8a2a
                  : 0x3e6a1a;
        roll.set(x, y + 1, c);
      }
    }
    roll.outline(0.86, LINE);
    buf.draw(roll, 0, 1 + r * (rollH + gap));
  }
  return {
    buf,
    ax: Math.round(w / 2),
    ay: h - 2,
    shadow: { rx: w / 2, ry: 2.5, dx: 1, dy: 0, a: 0.22 },
  };
}

// ── The farmhouse ────────────────────────────────────────────

/** Wood, paper and thatch tones sampled from a hand-drawn minka. */
export const W = {
  line: 0x470501,
  deep: 0x602710,
  shadow: 0x7a3c17,
  base: 0xa56436,
  mid: 0xb47744,
  warm: 0xc98149,
  light: 0xce8952,
  hi: 0xdea260,
  face: 0x9b582b,
  frame: 0x81512a,
} as const;
export const PAPER = { lit: 0xfff1d8, base: 0xf3d4aa, shade: 0xe0bc8a } as const;
export const THATCH = {
  hi: 0xac7b49,
  base: 0x8e613a,
  lo: 0x7a5230,
  deep: 0x5e3c20,
  moss: 0x7d8a34,
} as const;

/** What fills one bay (the space between two posts) of the house front. */
export type Bay = "shoji" | "shojiOpen" | "glass" | "room" | "blind" | "storeDoor";

/** One shoji panel: a dark frame, a paper lattice above, a wooden kickboard below. */
function shojiPanel(
  b: PixelBuffer,
  x: number,
  y: number,
  w: number,
  h: number,
  seed: number,
  grid = 3,
): void {
  b.rect(x, y, w, h, W.frame);
  const paperH = Math.round(h * 0.62);
  for (let yy = 1; yy < paperH; yy++) {
    for (let xx = 1; xx < w - 1; xx++) {
      const lattice = xx % grid === 0 || yy % (grid + 1) === 0;
      let c: Rgb = lattice ? W.mid : yy < paperH * 0.45 ? PAPER.lit : PAPER.base;
      if (!lattice && hash(x + xx, y + yy, seed) < 0.025) c = PAPER.shade;
      b.set(x + xx, y + yy, c);
    }
  }
  b.rect(x + 1, y + paperH, w - 2, 1, W.base);
  for (let yy = paperH + 1; yy < h - 1; yy++) {
    for (let xx = 1; xx < w - 1; xx++) {
      const c =
        yy === paperH + 1
          ? W.hi
          : yy === h - 2
            ? W.base
            : xx === Math.floor(w / 2)
              ? W.base
              : W.warm;
      b.set(x + xx, y + yy, c);
    }
  }
}

export function paintBay(
  b: PixelBuffer,
  kind: Bay,
  x: number,
  y: number,
  w: number,
  h: number,
  seed: number,
  sign?: Rgb,
): void {
  const half = Math.floor(w / 2);
  switch (kind) {
    case "shoji": {
      shojiPanel(b, x, y, half, h, seed);
      shojiPanel(b, x + half, y, w - half, h, seed + 1);
      return;
    }
    case "shojiOpen": {
      // The left panel slid across: a dim room with a tatami floor shows through.
      b.rect(x, y, half, h, 0x5a2e14);
      b.rect(x, y, half, 3, 0x40200c);
      b.rect(x, y + h - 8, half, 7, 0xb3a46a);
      b.rect(x, y + h - 8, half, 1, 0x7a6a3a);
      b.rect(x + 2, y + h - 6, 6, 3, 0xc84a3a);
      b.rect(x + 2, y + h - 6, 6, 1, 0xe07a6a);
      shojiPanel(b, x + half - 1, y, w - half + 1, h, seed, 4);
      b.rect(x + half - 2, y, 1, h, W.line);
      return;
    }
    case "glass": {
      const gh = Math.round(h * 0.6);
      b.rect(x, y, w, gh, W.frame);
      for (let yy = 2; yy < gh - 1; yy++) {
        for (let xx = 2; xx < w - 2; xx++) {
          const diag = xx + yy;
          let c: Rgb = 0xc9ddd2;
          if (diag > 6 && diag < 11) c = 0xe6f0ea;
          if (xx > w - 7 && yy > gh - 6) c = 0xa9c2b6;
          if (xx === half || yy === Math.floor(gh / 2)) c = W.frame;
          b.set(x + xx, y + yy, c);
        }
      }
      for (let yy = gh; yy < h; yy++) {
        for (let xx = 0; xx < w; xx++) {
          b.set(x + xx, y + yy, yy === gh ? W.hi : (yy - gh) % 4 === 0 ? W.base : W.warm);
        }
      }
      // A little plant in a pot on the sill.
      b.rect(x + 3, y + gh - 1, 5, 3, W.shadow);
      b.rect(x + 3, y + gh - 1, 5, 1, W.light);
      b.ellipse(x + 5.5, y + gh - 3, 2.6, 2, 0x63992a);
      b.set(x + 5, y + gh - 4, 0x8cbf3c);
      return;
    }
    case "room": {
      // A bright room through the open bay: an alcove with a scroll and a
      // vase, a doorway to a back room, a tatami floor and a red cushion.
      b.rect(x, y, w, h, 0xe6e3dc);
      b.rect(x, y, w, 3, 0xc6c0b6);
      b.rect(x + 2, y + 5, 7, h - 13, 0xbdb7ad);
      b.rect(x + 2, y + 5, 1, h - 13, 0xa8a298);
      b.rect(x + w - 11, y + 4, 9, h - 12, 0xd6d1c7);
      b.rect(x + w - 9, y + 6, 4, 10, PAPER.lit);
      b.rect(x + w - 9, y + 6, 4, 1, W.frame);
      b.rect(x + w - 9, y + 15, 4, 1, W.frame);
      for (const [ix, iy] of [
        [1, 3],
        [2, 4],
        [1, 6],
        [2, 7],
      ] as const) {
        b.set(x + w - 9 + ix, y + 6 + iy, 0x3a3a3a);
      }
      b.rect(x + w - 9, y + h - 10, 3, 3, 0x4a5a8a);
      b.set(x + w - 8, y + h - 11, 0x63992a);
      b.set(x + w - 8, y + h - 12, 0xd8394a);
      b.rect(x, y + h - 8, w, 8, 0xc8b878);
      b.rect(x, y + h - 8, w, 1, 0x8a7a40);
      b.rect(x + Math.floor(w * 0.5), y + h - 8, 1, 8, 0x8a7a40);
      b.rect(x + 3, y + h - 6, 7, 3, 0xc84a3a);
      b.rect(x + 3, y + h - 6, 7, 1, 0xe07a6a);
      if (sign !== undefined) {
        // A noren curtain over the top of the doorway.
        b.rect(x, y, w, 8, sign);
        for (let xx = x + 6; xx < x + w - 2; xx += 7) b.rect(xx, y, 1, 8, mix(sign, W.line, 0.35));
        b.rect(x, y + 7, w, 1, mix(sign, W.line, 0.35));
        b.rect(x + Math.floor(w / 2) - 2, y + 2, 4, 3, PAPER.lit);
      }
      return;
    }
    case "blind": {
      // Shoji behind a bamboo blind rolled two-thirds down.
      shojiPanel(b, x, y, half, h, seed);
      shojiPanel(b, x + half, y, w - half, h, seed + 1);
      const bh = Math.round(h * 0.6);
      for (let yy = 0; yy < bh; yy++) {
        for (let xx = 0; xx < w; xx++) {
          b.set(x + xx, y + yy, yy % 6 === 5 ? 0x9a7a3a : xx % 2 === 0 ? 0xd6b474 : 0xbf9a56);
        }
      }
      b.rect(x - 1, y + bh, w + 2, 2, 0x9a7a3a);
      b.rect(x - 1, y + bh, w + 2, 1, 0xe2c486);
      b.rect(x + 3, y + bh - 1, 1, 5, 0xd8394a);
      b.rect(x + w - 4, y + bh - 1, 1, 5, 0xd8394a);
      return;
    }
    case "storeDoor": {
      // A heavy board door with iron bands and a ring pull.
      for (let yy = 0; yy < h; yy++) {
        for (let xx = 0; xx < w; xx++) {
          const slat = yy % 4;
          b.set(
            x + xx,
            y + yy,
            slat === 0 ? W.hi : slat === 3 ? W.base : xx < 2 ? W.light : W.warm,
          );
        }
      }
      for (const by of [y + 5, y + h - 7]) {
        b.rect(x, by, w, 2, 0x3c3430);
        for (let rx = x + 2; rx < x + w; rx += 6) b.set(rx, by, 0x8a8078);
      }
      b.ellipse(x + w - 5, y + Math.floor(h / 2), 1.7, 1.7, 0x3c3430);
      b.set(x + w - 5, y + Math.floor(h / 2), W.warm);
      return;
    }
  }
}

/** Ragged, streaky blotches of lighter straw across a thatch roof. */
export function thatchBlotch(x: number, y: number, seed: number): number {
  const cell = 13;
  let best = 0;
  for (let gy = Math.floor(y / 7) - 1; gy <= Math.floor(y / 7) + 1; gy++) {
    for (let gx = Math.floor(x / cell) - 1; gx <= Math.floor(x / cell) + 1; gx++) {
      if (hash(gx, gy, seed + 7) > 0.3) continue;
      const ox = gx * cell + hash(gx, gy, seed + 8) * cell;
      const oy = gy * 7 + hash(gx, gy, seed + 9) * 7;
      const rx = 6 + hash(gx, gy, seed + 10) * 8;
      const ry = 1.1 + hash(gx, gy, seed + 11) * 1.3;
      const hang = hash(Math.floor(x / 2), gy, seed + 12) * 2.2;
      const d =
        ((x - ox) / rx) ** 2 +
        (Math.max(0, y - oy - hang) / ry) ** 2 +
        (Math.min(0, y - oy) / ry) ** 2;
      best = Math.max(best, 1 - d);
    }
  }
  return best;
}

/**
 * A big minka farmhouse: a heavy thatched hip roof (sunlit hip on the left,
 * shaded on the right, moss near the ridge, a smoke vent on top, a ragged
 * straw fringe), a row of rafter ends under the eave, posts with a lit face,
 * bays that are each different, a paper lantern and a wind chime hanging
 * from the eave, and a raised veranda on foundation stones with sandals at
 * the step.
 */
export function farmhouse(
  seed: number,
  bays: readonly Bay[] = ["shoji", "shojiOpen", "glass", "room", "blind", "storeDoor"],
  sign?: Rgb,
): Sprite {
  const bayW = 32;
  const front = bays.length * bayW + 5;
  const over = 13;
  const w = front + over * 2;
  const roofH = 60;
  const eaveY = roofH;
  const lintelY = eaveY + 4;
  const wallH = 30;
  const deckY = lintelY + wallH;
  const deckH = 10;
  const h = deckY + deckH + 4;
  const left = over;
  const b = new PixelBuffer(w, h);

  // The front: deep shadow behind, then each bay, then posts over them.
  b.rect(left, lintelY, front, wallH, W.deep);
  bays.forEach((kind, i) => {
    paintBay(
      b,
      kind,
      left + 5 + i * bayW,
      lintelY + 1,
      bayW - 5,
      wallH - 1,
      seed + i * 13,
      kind === "room" ? sign : undefined,
    );
  });
  for (let i = 0; i <= bays.length; i++) {
    const px = left + i * bayW;
    for (let k = 0; k < wallH; k++) {
      b.set(px, lintelY + k, W.line);
      b.set(px + 1, lintelY + k, W.hi);
      b.set(px + 2, lintelY + k, W.warm);
      b.set(px + 3, lintelY + k, W.base);
      b.set(px + 4, lintelY + k, W.line);
    }
  }

  // The veranda: long boards, a lit nosing, foundation stones under it.
  for (let yy = 0; yy < deckH - 3; yy++) {
    for (let x = left - 9; x < left + front + 9; x++) {
      const c =
        yy === 0
          ? W.hi
          : yy % 3 === 0
            ? W.base
            : (x + Math.floor(yy / 3) * 17) % 37 === 0
              ? W.base
              : W.light;
      b.set(x, deckY + yy, c);
    }
  }
  b.rect(left - 9, deckY + deckH - 3, front + 18, 2, W.face);
  b.rect(left - 9, deckY + deckH - 3, front + 18, 1, W.warm);
  b.rect(left - 9, deckY + deckH - 1, front + 18, 1, W.line);
  for (let i = 0; i <= bays.length; i++) {
    const px = left + i * bayW - 1;
    b.rect(px, deckY + deckH, 7, 3, 0x9a928a);
    b.rect(px, deckY + deckH, 7, 1, 0xc8c1b8);
  }
  // A step stone in front of the open room, and sandals on it.
  const room = bays.indexOf("room");
  if (room >= 0) {
    const sx = left + 5 + room * bayW + 4;
    b.rect(sx, deckY + deckH, bayW - 13, 4, 0xc8c1b8);
    b.rect(sx, deckY + deckH, bayW - 13, 1, 0xe8e2da);
    b.rect(sx, deckY + deckH + 3, bayW - 13, 1, 0x8d847b);
    for (const gx of [sx + 4, sx + 9]) {
      b.rect(gx, deckY + deckH + 1, 3, 2, W.mid);
      b.set(gx + 1, deckY + deckH + 1, 0xc84a3a);
    }
  }

  // The roof: a hip of thatch, wider at the eave than at the ridge.
  for (let y = 0; y < roofH; y++) {
    const t = y / roofH;
    const half = Math.round(front * 0.33 + Math.pow(t, 0.6) * (w / 2 - front * 0.33));
    const L = Math.round(w / 2 - half);
    const R = Math.round(w / 2 + half);
    const hip = Math.round(5 + t * 16);
    for (let x = L; x < R; x++) {
      const lift = thatchBlotch(x, y, seed);
      const hollow = noise(x * 0.4, y * 1.3, 5, seed + 3) < 0.18;
      let c: Rgb =
        lift > 0 ? (lift > 0.55 ? THATCH.hi : mix(THATCH.base, THATCH.hi, 0.55)) : THATCH.base;
      if (hollow && lift <= 0) c = THATCH.lo;
      if (x < L + hip) c = mix(c, THATCH.hi, 0.3); // the sunlit hip
      if (x >= R - hip) c = mix(c, THATCH.deep, 0.42); // the shaded hip
      if (x === L + hip || x === R - hip - 1) c = THATCH.lo; // hip ridges
      if (t < 0.4 && noise(x, y, 3, seed + 21) > 0.82) c = mix(c, THATCH.moss, 0.55); // moss
      if (y >= roofH - 6) {
        const tooth = Math.floor(hash(Math.floor(x / 2), 9, seed) * 4);
        c = y >= roofH - 6 + tooth ? THATCH.deep : THATCH.lo;
      }
      b.set(x, y, c);
    }
  }
  // The ridge, capped, with a little smoke vent at its middle.
  const rL = Math.round(w / 2 - front * 0.33) + 2;
  const rR = Math.round(w / 2 + front * 0.33) - 2;
  b.rect(rL, 0, rR - rL, 5, THATCH.lo);
  b.rect(rL, 0, rR - rL, 1, THATCH.hi);
  b.rect(rL + 2, 2, rR - rL - 4, 2, W.deep);
  for (let x = rL + 6; x < rR - 6; x += 12) b.rect(x, 1, 3, 4, W.line);
  const vx = Math.round(w / 2) - 9;
  b.rect(vx, 0, 18, 7, W.frame);
  for (let xx = 1; xx < 17; xx += 2) b.rect(vx + xx, 2, 1, 4, PAPER.shade);
  b.rect(vx - 2, 0, 22, 2, THATCH.lo);
  // Rafter ends under the eave, then the lintel beam over the bays.
  for (let x = left - 7; x < left + front + 7; x += 6) {
    b.rect(x, eaveY, 4, 3, PAPER.base);
    b.rect(x + 3, eaveY, 1, 3, W.base);
    b.rect(x, eaveY + 3, 4, 1, W.line);
  }
  b.rect(left - 3, lintelY - 1, front + 6, 3, W.warm);
  b.rect(left - 3, lintelY - 1, front + 6, 1, W.hi);
  b.rect(left - 3, lintelY + 2, front + 6, 1, W.line);
  // The eave's shadow down the top of the front.
  for (let x = left; x < left + front; x++) {
    for (let k = 3; k < 8; k++) b.set(x, lintelY + k, W.line, 0.34 - (k - 3) * 0.07);
  }

  // A red paper lantern, and a glass wind chime with its paper strip.
  const lx = left + Math.max(1, room) * bayW + 2;
  b.rect(lx, eaveY + 4, 1, 4, W.line);
  b.ellipse(lx + 0.5, eaveY + 12, 3.2, 4.2, 0xd8394a);
  b.rect(lx - 2, eaveY + 9, 1, 7, 0xa82838);
  b.rect(lx + 2, eaveY + 9, 1, 7, 0xa82838);
  b.rect(lx - 1, eaveY + 11, 3, 2, 0xffb070);
  b.rect(lx - 2, eaveY + 8, 5, 1, 0x2a1a14);
  b.rect(lx - 2, eaveY + 16, 5, 1, 0x2a1a14);
  const cx = left + bayW + 14;
  b.rect(cx, eaveY + 4, 1, 3, W.line);
  b.ellipse(cx + 0.5, eaveY + 8, 2, 1.8, 0xbfe4ee);
  b.set(cx, eaveY + 7, 0xffffff);
  b.rect(cx, eaveY + 10, 1, 2, W.line);
  b.rect(cx - 1, eaveY + 12, 3, 5, PAPER.lit);
  b.rect(cx - 1, eaveY + 14, 3, 1, 0xd8394a);

  b.outline(0.9, W.line);
  return {
    buf: b,
    ax: Math.round(w / 2),
    ay: deckY + deckH + 1,
    shadow: { rx: w / 2 - 6, ry: 8, dx: 8, dy: -2, a: 0.34 },
  };
}

/**
 * A side wing with a board roof held down by stones and battens, a plaster
 * wall in a dark timber frame, a barred window, and firewood stacked under a
 * lean-to.
 */
export function annex(seed: number): Sprite {
  const w = 76;
  const h = 70;
  return sprite(
    w,
    h,
    44,
    68,
    (b) => {
      // The wall: plaster panels in a timber frame, with a barred window.
      b.rect(24, 30, 48, 36, 0xe9dbb9);
      for (const x of [24, 47, 70]) b.rect(x, 30, 3, 36, W.base);
      b.rect(24, 30, 48, 3, W.warm);
      b.rect(24, 52, 48, 3, W.warm);
      b.rect(24, 63, 48, 3, W.face);
      b.rect(31, 36, 12, 12, W.deep);
      for (let x = 32; x < 43; x += 2) b.rect(x, 36, 1, 12, 0xc8a868);
      b.rect(30, 35, 14, 1, W.hi);
      b.rect(50, 36, 17, 14, 0xd6c7ad);
      b.rect(50, 36, 17, 1, W.shadow);
      // The board roof: planks running down the slope, battens across, stones.
      for (let y = 4; y < 30; y++) {
        const inset = Math.round((30 - y) * 0.25);
        for (let x = 18 + inset; x < 76 - inset * 0.3; x++) {
          const plank = (x - 18) % 5 === 0;
          let c: Rgb = plank ? W.base : x < 34 ? W.hi : W.warm;
          if (y % 8 === 0) c = W.face;
          if (hash(x, y, seed) < 0.03) c = W.light;
          b.set(x, y, c);
        }
      }
      for (const [sx, sy] of [
        [28, 8],
        [44, 16],
        [60, 9],
        [36, 22],
        [66, 20],
      ] as const) {
        b.ellipse(sx, sy, 3, 2.2, 0xb0a89f);
        b.set(sx - 1, sy - 1, 0xe2dcd4);
      }
      b.rect(18, 28, 58, 3, W.shadow);
      // The lean-to on the left, with split logs stacked under it.
      for (let y = 22; y < 30; y++) {
        for (let x = 2; x < 26; x++) b.set(x, y, (x - 2) % 4 === 0 ? W.base : W.warm);
      }
      b.rect(2, 29, 24, 2, W.shadow);
      b.rect(4, 31, 2, 35, W.base);
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 3; c++) {
          const lx = 8 + c * 6 + (r % 2) * 3;
          const ly = 44 + r * 6;
          b.ellipse(lx, ly, 2.8, 2.6, 0xc98149);
          b.ellipse(lx, ly, 1.6, 1.4, 0xe8c08a);
          b.set(lx, ly, 0xb87a40);
        }
      }
    },
    { rx: 32, ry: 5, dx: 4, dy: -1, a: 0.3 },
  );
}

/** A little wooden dog house with a gable roof, an arched door and a bowl. */
export function kennel(): Sprite {
  return sprite(
    30,
    30,
    15,
    28,
    (b) => {
      for (let y = 12; y < 26; y++) {
        for (let x = 4; x < 26; x++)
          b.set(x, y, (x - 4) % 4 === 0 ? W.base : x < 8 ? W.light : W.warm);
      }
      b.ellipse(15, 21, 5, 6, W.line);
      b.rect(10, 21, 11, 5, W.line);
      b.ellipse(15, 21, 3.6, 4.6, 0x2a1408);
      b.rect(12, 7, 7, 3, PAPER.base);
      b.rect(12, 7, 7, 1, W.frame);
      for (let y = 0; y < 13; y++) {
        const half = Math.round(4 + y * 0.95);
        for (let x = 15 - half; x <= 15 + half; x++) {
          const right = x > 15;
          const course = (y + Math.abs(x - 15)) % 4 === 0;
          b.set(x, y + 1, course ? W.base : right ? W.face : W.hi);
        }
      }
      b.ellipse(23, 27, 3.4, 1.8, 0xc84a3a);
      b.ellipse(23, 26.6, 2.4, 1, 0x8a2a20);
    },
    { rx: 12, ry: 2.5, dx: 2, dy: -1, a: 0.3 },
  );
}

// ── Stations, in the farm's style ────────────────────────────

/** A low round table (chabudai) with a laptop on it, glowing: the web corner. */
export function laptopTable(): Sprite {
  return sprite(
    24,
    16,
    12,
    14,
    (b) => {
      b.ellipse(12, 10, 10, 3.6, W.warm);
      b.ellipse(11, 9.4, 8, 2.4, W.hi);
      b.rect(5, 12, 2, 3, W.base);
      b.rect(17, 12, 2, 3, W.base);
      b.rect(7, 2, 10, 7, 0x2a2a34);
      b.rect(8, 3, 8, 5, 0x6ad0f0);
      b.rect(8, 3, 3, 2, 0xb8ecff);
      b.rect(6, 9, 12, 1, 0x4a4a54);
    },
    { rx: 10, ry: 2.2, dx: 1, dy: 0, a: 0.28 },
  );
}

/** A low bookcase stacked with books, with one lying open on top. */
export function bookcase(seed: number): Sprite {
  return sprite(
    22,
    20,
    11,
    18,
    (b) => {
      b.rect(2, 4, 18, 14, W.base);
      b.rect(2, 4, 18, 1, W.hi);
      const colors = [0xc84a3a, 0x3a6aa8, 0xe8b84a, 0x5a8a3a, 0x8a4aa0, 0xd88a4a];
      for (const shelf of [6, 12]) {
        let x = 3;
        while (x < 19) {
          const bw = 1 + Math.floor(hash(x, shelf, seed) * 2);
          const bh = 4 + Math.floor(hash(x, shelf + 1, seed) * 2);
          b.rect(
            x,
            shelf + 5 - bh,
            bw,
            bh,
            colors[Math.floor(hash(x, shelf + 2, seed) * colors.length)] ?? 0xc84a3a,
          );
          x += bw + (hash(x, shelf + 3, seed) < 0.2 ? 1 : 0);
        }
        b.rect(3, shelf + 5, 16, 1, W.face);
      }
      b.rect(6, 1, 10, 3, PAPER.lit);
      b.rect(11, 1, 1, 3, W.frame);
    },
    { rx: 9, ry: 2, dx: 1, dy: 0, a: 0.28 },
  );
}

/** A carpenter's bench with a plane, a saw on the wall-peg and shavings. */
export function carpentryBench(): Sprite {
  return sprite(
    30,
    22,
    15,
    20,
    (b) => {
      b.rect(2, 8, 26, 4, W.hi);
      b.rect(2, 11, 26, 2, W.face);
      for (const x of [4, 24]) b.rect(x, 12, 3, 8, W.base);
      b.rect(4, 16, 23, 1, W.base);
      b.rect(9, 5, 8, 3, W.warm);
      b.rect(10, 4, 3, 1, 0x3c3430);
      b.rect(19, 6, 6, 2, 0xc8c1b8);
      b.rect(19, 5, 2, 1, W.base);
      for (const [x, y] of [
        [6, 19],
        [12, 20],
        [20, 19],
        [16, 21],
      ] as const) {
        b.rect(x, y, 2, 1, 0xf0d0a0);
      }
    },
    { rx: 13, ry: 2.4, dx: 1, dy: 0, a: 0.3 },
  );
}

/** A clay kamado stove with two fire mouths glowing and a pot steaming on top. */
export function kamado(): Sprite {
  return sprite(
    30,
    24,
    15,
    22,
    (b) => {
      for (let y = 8; y < 22; y++) {
        for (let x = 2; x < 28; x++) {
          const round = (x - 15) ** 2 / 169 + (y - 15) ** 2 / 400 > 1;
          if (round) continue;
          b.set(x, y, y < 11 ? 0xe2b07a : x < 9 ? 0xd09a62 : x > 22 ? 0x9a6436 : 0xb8804a);
        }
      }
      for (const fx of [9, 20]) {
        b.ellipse(fx, 17, 3, 2.8, 0x2a1408);
        b.ellipse(fx, 18, 2, 1.6, 0xff8a2a);
        b.set(fx, 17, 0xffd27a);
      }
      b.ellipse(15, 7, 7, 2.6, 0x3c3430);
      b.ellipse(15, 6, 5.6, 1.8, 0x5a524c);
      b.rect(13, 3, 4, 2, 0x3c3430);
    },
    { rx: 13, ry: 2.6, dx: 1, dy: 0, a: 0.3 },
  );
}

/** A wooden board under a little roof, with notes, a plan and a red seal pinned to it. */
export function notesBoard(seed: number): Sprite {
  return sprite(
    30,
    32,
    15,
    30,
    (b) => {
      for (const x of [5, 23]) b.rect(x, 8, 2, 22, W.base);
      b.rect(3, 9, 24, 15, W.warm);
      b.rect(3, 9, 24, 1, W.hi);
      b.rect(4, 10, 22, 13, 0xd8b884);
      const rnd = stream(seed);
      for (let i = 0; i < 4; i++) {
        const nx = 5 + i * 5 + Math.round(rnd() * 2);
        const ny = 11 + Math.round(rnd() * 4);
        b.rect(nx, ny, 4, 6, PAPER.lit);
        b.rect(nx + 1, ny + 2, 2, 1, 0x8a8a9a);
        b.rect(nx + 1, ny + 4, 2, 1, 0x8a8a9a);
        b.set(nx + 1, ny, 0xc84a3a);
      }
      b.ellipse(22, 20, 1.6, 1.6, 0xd8394a);
      for (let y = 0; y < 8; y++) {
        const half = Math.round(6 + y * 1.4);
        for (let x = 15 - half; x <= 15 + half; x++)
          b.set(x, y + 1, y === 7 ? W.base : x > 15 ? W.face : W.hi);
      }
    },
    { rx: 11, ry: 2.4, dx: 1, dy: 0, a: 0.3 },
  );
}

/** A red Japanese pillar post box, with a white slot plate. */
export function postBox(): Sprite {
  return sprite(
    14,
    24,
    7,
    22,
    (b) => {
      b.ellipse(7, 4, 5, 2.6, 0xe0403a);
      b.ellipse(6.5, 3.4, 3.4, 1.4, 0xf87a6a);
      b.rect(2, 4, 10, 17, 0xc8302c);
      b.rect(2, 4, 2, 17, 0xe85a50);
      b.rect(10, 4, 2, 17, 0x8a1e1c);
      b.rect(4, 8, 6, 2, 0x2a1408);
      b.rect(4, 12, 6, 4, PAPER.lit);
      b.rect(5, 13, 4, 1, 0xc8302c);
      b.rect(1, 20, 12, 2, 0x5a524c);
    },
    { rx: 5, ry: 1.8, dx: 1, dy: 0, a: 0.3 },
  );
}

/** A fishing rod leaning out over the water, its float bobbing, a basket beside it. */
export function fishingSpot(): Sprite {
  return sprite(
    34,
    26,
    8,
    24,
    (b) => {
      for (let i = 0; i < 26; i++)
        b.set(4 + i, 22 - Math.round(i * 0.7), i < 8 ? W.base : 0x8a6a3a);
      for (let y = 5; y < 18; y++) b.set(30, y, 0xe6e3dc);
      b.rect(29, 18, 3, 2, 0xd8394a);
      b.rect(29, 17, 3, 1, 0xffffff);
      b.ellipse(8, 20, 5, 4, 0xc8a868);
      for (let x = 4; x < 13; x += 2) b.rect(x, 17, 1, 7, 0x9a7a3a);
      b.ellipse(8, 17, 4, 1.4, 0x5a3a1a);
    },
    { rx: 6, ry: 1.8, dx: 0, dy: 0, a: 0.28 },
  );
}

/** A long bench with a red felt cloth, a tea tray and a red parasol: the place to wait. */
export function teaBench(): Sprite {
  return sprite(
    44,
    40,
    22,
    38,
    (b) => {
      b.rect(4, 26, 36, 5, 0xc8302c);
      b.rect(4, 26, 36, 1, 0xe85a50);
      b.rect(4, 30, 36, 1, 0x8a1e1c);
      for (const x of [6, 36]) b.rect(x, 31, 3, 7, W.base);
      b.rect(26, 23, 9, 3, W.warm);
      b.ellipse(29, 22, 2, 1.6, 0x5a7a4a);
      b.rect(32, 22, 2, 1, PAPER.lit);
      // The parasol: a wide, shallow red cone on a bamboo pole.
      b.rect(12, 6, 1, 22, 0xc8a868);
      for (let y = 0; y < 8; y++) {
        const half = Math.round(4 + y * 2.2);
        for (let x = 12 - half; x <= 12 + half; x++) {
          const rib = (x - 12 + 30) % 5 === 0;
          b.set(x, y, rib ? 0xa82838 : x < 12 ? 0xe85a50 : 0xc8302c);
        }
      }
      b.rect(-6 + 12, 7, 25, 1, 0x8a1e1c);
    },
    { rx: 18, ry: 3, dx: 1, dy: 0, a: 0.3 },
  );
}

// ── Little things ────────────────────────────────────────────

/** A forked twig lying on the ground. */
export function twig(seed: number): Sprite {
  return sprite(
    14,
    8,
    7,
    6,
    (b) => {
      const flip = hash(seed, 0, 1) < 0.5;
      for (let i = 0; i < 11; i++) b.set(flip ? 12 - i : 1 + i, 5 - Math.round(i * 0.25), W.base);
      for (let i = 0; i < 4; i++) b.set(flip ? 7 - i : 6 + i, 3 - i, W.base);
    },
    undefined,
    0.7,
  );
}

/** A few pebbles. */
export function pebbles(seed: number): Sprite {
  return sprite(
    12,
    7,
    6,
    5,
    (b) => {
      const rnd = stream(seed);
      for (let i = 0; i < 3; i++) {
        const x = 2 + Math.round(rnd() * 7);
        const y = 2 + Math.round(rnd() * 2);
        b.rect(x, y, 2, 1, ST.light);
        b.set(x, y + 1, ST.mid);
      }
    },
    undefined,
    0.7,
  );
}
