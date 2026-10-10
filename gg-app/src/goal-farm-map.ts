// The farm a started Goal's team works on: the farmstead layout (a thatched
// farmhouse, a storehouse, a koi pond, fields, a tea bench by the fire) plus
// everything the live view needs to bring it to life: where each station's
// critters stand, the yard's walkways, the things paths must not cross, and
// the anchors for what moves (fire, steam, koi, petals, animals). The core
// farm is fixed at 30×19 tiles; a bigger window gets more countryside around
// it, so the map always fills the view edge to edge. Pure.

import { E, WARM_INK, hash, mix } from "./goal-map-pixels";
import { GRASS_SUN, GridBuilder, TILE } from "./goal-map-ground";
import type { MapScene, PlacedProp } from "./goal-map-compose";
import type { Sprite } from "./goal-map-props";
import {
  K,
  camelliaTree,
  chicken,
  dragonfly,
  flowerClump,
  petals,
  sakuraTree,
  shibaDog,
  stake,
  steam,
  tallGrass,
  walkingCat,
  yuzuTree,
} from "./goal-map-cozy";
import {
  bookcase,
  fishingSpot,
  laptopTable,
  pebbles,
  raisedBed,
  stone,
  teaRows,
  twig,
} from "./goal-map-farm";
import {
  annexTop,
  benchTop,
  canopyTree,
  farmhouseTop,
  fireTop,
  kennelTop,
  kuraTop,
  lanternTop,
  moundShrub,
  notesBoardTop,
  pondTop,
  postBoxTop,
  spoutTop,
  stoveTop,
  teaBenchTop,
  toriiTop,
  tubTop,
} from "./goal-map-topdown";
import type { PathGraph, Spot } from "./goal-farm-travel";
import type { StationKind } from "./goal-world-stations";

/** The farmstead itself, in tiles. */
export const FARM_CORE = { cols: 30, rows: 19 } as const;

/** The standard ground colours, warmed into this world's earthy palette. */
export const WARM_GROUND: ReadonlyMap<number, number> = new Map<number, number>([
  [E.green2, K.grass],
  [GRASS_SUN, 0x9aad2c],
  [E.green1, K.grassDark],
  [E.green3, K.grassLight],
  [E.teal0, K.grassDeep],
  [E.leaf, K.grassLight],
  [E.tan, K.soil],
  [mix(E.tan, E.sand, 0.35), mix(K.soil, K.soilLight, 0.4)],
  [mix(E.tan, E.bark3, 0.25), mix(K.soil, K.soilDark, 0.5)],
  [mix(E.tan, E.bark3, 0.55), K.soilDark],
  [mix(E.tan, E.bark3, 0.6), K.soilDark],
  [E.bark3, K.soilDark],
  [E.sand, mix(K.soil, K.soilLight, 0.55)],
  [E.blue2, K.water],
  [E.blue1, K.waterDark],
  [E.sky, K.waterLight],
  [E.navy, 0x3f8f96],
  // Cliff faces and stair edges: from cold bark to warm earth.
  [E.bark1, 0x7a4a1c],
  [E.bark2, 0xa0682a],
  [mix(E.bark2, E.bark1, 0.35), 0x8e5a24],
  [mix(E.bark2, E.bark3, 0.35), 0xb07a36],
  [mix(E.bark2, E.bark1, 0.5), 0x86531f],
]);

/** An axis-aligned box on the map: something paths must go around. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The places that move in the live view, in map pixels. */
export interface Ambient {
  /** The campfire pit (flames rise from here). */
  readonly fire: Spot;
  /** Where steam leaves the kettle and the stove's pots. */
  readonly steam: readonly Spot[];
  /** The middle of the koi pond, and how far the koi may swim from it. */
  readonly pond: {
    readonly x: number;
    readonly y: number;
    readonly rx: number;
    readonly ry: number;
  };
  /** Blossom canopies petals drift down from. */
  readonly blossoms: ReadonlyArray<{ readonly x: number; readonly y: number; readonly r: number }>;
  readonly chickens: ReadonlyArray<{
    readonly x: number;
    readonly y: number;
    readonly flip: boolean;
  }>;
  /** Where the dragonfly hovers. */
  readonly dragonfly: Spot;
  /** The cat's beat: it pads back and forth between these. */
  readonly cat: readonly [Spot, Spot];
}

export interface Farm {
  /** The static map (ground and props; no critters, nothing that moves). */
  readonly scene: MapScene;
  /** Where the farmstead's top-left corner sits on the map, in pixels. */
  readonly origin: Spot;
  readonly width: number;
  readonly height: number;
  /** Where critters stand at each station, slot by slot (slot 0 first). */
  readonly stations: Readonly<Record<StationKind, readonly Spot[]>>;
  /** The yard's walkways. */
  readonly paths: PathGraph;
  /** What walkways keep clear of (buildings, the pond, trunks, beds, hedges). */
  readonly obstacles: readonly Rect[];
  readonly ambient: Ambient;
}

export interface FarmOptions {
  /** Map size in tiles; never smaller than the farmstead. */
  readonly cols?: number;
  readonly rows?: number;
  /** Varies the countryside around the farmstead (the farmstead never changes). */
  readonly seed?: number;
  /**
   * Tiles at the top the farmstead keeps below: the window's see-through
   * header sits over them, so only countryside shows there.
   */
  readonly top?: number;
  /**
   * A still picture: bake the fire's flames, steam, koi and animals into the
   * map. The live view leaves them out and animates them itself.
   */
  readonly still?: boolean;
}

// ── Where things are, in farmstead pixels ─────────────────────

const SPOTS: Readonly<Record<StationKind, ReadonlyArray<readonly [number, number]>>> = {
  door: [
    [25, 226],
    [42, 230],
    [10, 232],
    [56, 236],
  ],
  bookcase: [
    [128, 128],
    [116, 130],
    [140, 131],
  ],
  computer: [
    [167, 129],
    [181, 131],
  ],
  whiteboard: [
    [372, 119],
    [386, 121],
    [358, 122],
  ],
  workbench: [
    [413, 167],
    [400, 169],
  ],
  machine: [
    [455, 168],
    [468, 171],
  ],
  maptable: [
    [148, 188],
    [160, 194],
  ],
  mailbox: [
    [62, 227],
    [72, 231],
  ],
  lounge: [
    [330, 214],
    [350, 215],
    [382, 222],
    [414, 223],
    [398, 231],
    [366, 225],
    [310, 220],
  ],
};

/** The walkways: one node by every station, and the junctions between them. */
const PATH_NODES: ReadonlyArray<readonly [number, number]> = [
  [25, 228], // 0 the gate
  [44, 230], // 1 just inside the gate
  [62, 228], // 2 the post box
  [100, 214], // 3 below the pond
  [148, 192], // 4 the fishing spot
  [190, 180], // 5 past the tub
  [222, 182], // 6 the lane, halfway
  [222, 140], // 7 the top of the lane
  [168, 130], // 8 the laptop
  [128, 129], // 9 the bookcase
  [96, 120], // 10 the yard, west
  [262, 140], // 11 the yard in front of the house
  [304, 132], // 12 the yard, east
  [372, 121], // 13 the notes board
  [394, 132], // 14 east of the notes board, before the storehouse
  [413, 169], // 15 the carpenter's bench
  [455, 170], // 16 the stove
  [382, 168], // 17 under the blossom
  [382, 224], // 18 the fire, west
  [334, 216], // 19 the tea bench
  [416, 226], // 20 the fire, east
  [222, 214], // 21 the lane, low
  [300, 214], // 22 the yard, south-east
];

const PATH_EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [8, 9],
  [9, 10],
  [7, 11],
  [11, 12],
  [12, 13],
  [13, 14],
  // The bench is reached from below (via 17): a walkway down from 14 would
  // run through the bench itself.
  [15, 16],
  [15, 17],
  [13, 17],
  [17, 18],
  [18, 19],
  [18, 20],
  [20, 16],
  [6, 21],
  [21, 22],
  [22, 19],
  [21, 3],
];

/** Footprints walkways must not cross (farmstead pixels). */
const OBSTACLES: ReadonlyArray<readonly [number, number, number, number]> = [
  [100, 0, 210, 116], // the farmhouse and its veranda
  [18, 50, 78, 50], // the side building
  [52, 136, 82, 58], // the koi pond and its stones
  [152, 150, 22, 16], // the tub
  [322, 76, 32, 30], // the kennel
  [358, 78, 32, 30], // the notes board
  [413, 6, 62, 116], // the storehouse and its platform
  [398, 138, 36, 20], // the carpenter's bench
  [438, 134, 36, 24], // the stove
  [318, 176, 44, 34], // the tea bench and parasol
  [384, 188, 28, 24], // the fire pit
  [16, 124, 14, 12], // tree trunks
  [284, 160, 10, 16],
  [328, 138, 8, 14],
  [360, 170, 8, 12],
  [262, 196, 8, 10],
  [452, 190, 8, 10],
  [72, 226, 128, 12], // the hedgerows
  [248, 226, 52, 12],
  [424, 226, 56, 12],
  [8, 262, 466, 42], // the fields
];

// ── Building the farm ─────────────────────────────────────────

/** Lay out the farm on a map of `cols × rows` tiles (at least the farmstead). */
export function buildFarm(options: FarmOptions = {}): Farm {
  const cols = Math.max(FARM_CORE.cols, Math.floor(options.cols ?? FARM_CORE.cols));
  const rows = Math.max(FARM_CORE.rows, Math.floor(options.rows ?? FARM_CORE.rows));
  const still = options.still ?? false;
  const seed = options.seed ?? 13;
  const top = Math.max(0, Math.floor(options.top ?? 0));
  const tox = Math.floor((cols - FARM_CORE.cols) / 2);
  // Centred in the part of the map below the header, never off the map.
  const toy = Math.max(
    0,
    Math.min(rows - FARM_CORE.rows, top + Math.floor((rows - top - FARM_CORE.rows) / 2)),
  );
  const ox = tox * TILE;
  const oy = toy * TILE;
  const at = (x: number, y: number): Spot => ({ x: x + ox, y: y + oy });

  // ── Ground: worn earth in front of the house and down the lane ──
  const g = new GridBuilder(cols, rows);
  g.rect(3 + tox, 5 + toy, 25, 3, "d");
  g.ellipse(15 + tox, 9 + toy, 12, 4.2, "d");
  g.rect(13 + tox, 9 + toy, 3, 5, "d");
  g.ellipse(26 + tox, 8.5 + toy, 4, 3, "d");
  g.ellipse(4 + tox, 12.6 + toy, 4.4, 1.6, "d");
  // The lane out through the gate runs on to the edge of the map.
  g.rect(0, 12 + toy, 3 + tox, 2, "d");
  g.ellipse(9.5 + tox, 7.3 + toy, 1.4, 0.8, ".");
  g.ellipse(20.6 + tox, 10.6 + toy, 1.7, 1, ".");
  g.ellipse(17.4 + tox, 6.6 + toy, 0.9, 0.7, ".");

  const props: PlacedProp[] = [];
  const P = (sprite: Sprite, x: number, y: number, extra: Partial<PlacedProp> = {}): void => {
    props.push({ sprite, x: x + ox, y: y + oy, ...extra });
  };
  const flat = (sprite: Sprite, x: number, y: number): void => {
    props.push({ sprite, x: x + ox, y: y + oy, flat: true });
  };

  // ── Buildings along the top ──
  P(annexTop(301), 58, 98);
  P(
    farmhouseTop(302, ["shoji", "shojiOpen", "glass", "room", "blind", "storeDoor"], 0x3a5a9a),
    205,
    112,
  );
  P(kennelTop(), 338, 104);
  P(shibaDog(), 338, 113);
  P(notesBoardTop(303), 374, 106);
  P(kuraTop(304), 444, 120);
  P(sakuraTree(305, false), 470, 44);
  P(moundShrub(306, "olive", 12), 396, 50);

  // ── The lane: stepping stones from the house down through the fields ──
  const lane: ReadonlyArray<readonly [number, number, "m" | "l"]> = [
    [227, 120, "l"],
    [218, 137, "m"],
    [227, 154, "m"],
    [217, 171, "l"],
    [226, 188, "m"],
    [217, 205, "m"],
    [226, 222, "l"],
    [217, 240, "m"],
    [226, 258, "m"],
    [218, 277, "l"],
    [226, 296, "m"],
  ];
  lane.forEach(([x, y, size], i) => flat(stone(310 + i * 7, size, i % 4 === 3), x, y));
  P(lanternTop(), 196, 128);
  P(lanternTop(), 254, 128);

  // ── The front yard: the reading and web corner in front of the veranda ──
  P(bookcase(311), 128, 116);
  P(laptopTable(), 160, 118);
  P(stone(312, "s"), 106, 118);
  P(stone(313, "s", true), 186, 112);

  // ── The pond, the spout feeding it, the tub and the fishing spot ──
  P(pondTop(66, 38, 314, still), 92, 190);
  P(spoutTop(), 36, 166);
  P(tubTop(), 162, 164);
  P(stake(), 188, 142);
  // The rod leans out over the water, its float in the pond.
  P(fishingSpot(), 140, 182, { flip: true });
  P(canopyTree(315, "green", 1.05), 22, 134);
  P(sakuraTree(316), 24, 64);
  flat(petals(317, 10, 16), 24, 74);

  // ── The gate out on the left, the post box by it ──
  P(toriiTop(), 24, 220);
  P(postBoxTop(), 52, 216);

  // ── The right yard: shade, blossom over the tea bench, the fire ──
  P(canopyTree(318, "olive", 0.9), 288, 176);
  P(sakuraTree(319), 332, 152);
  P(sakuraTree(320, false), 364, 182);
  flat(petals(321, 12, 18), 340, 160);
  flat(petals(322, 8, 14), 366, 190);
  P(teaBenchTop(), 340, 208);
  P(fireTop(still), 398, 210);
  P(camelliaTree(324), 266, 206);
  P(yuzuTree(325), 456, 200);

  // ── Work, by the storehouse: the carpenter's bench and the stove ──
  P(benchTop(), 416, 156);
  P(stoveTop(), 456, 156);

  // ── A hedgerow between the yard and the fields, open where the lane runs ──
  const hedge = (x0: number, x1: number, y: number, s: number): void => {
    let x = x0;
    let i = 0;
    while (x < x1) {
      const tone = (["olive", "green", "amber", "green", "olive"] as const)[(s + i) % 5] ?? "green";
      const large = hash(i, 1, s) < 0.4;
      P(moundShrub(s + i, tone, large ? 12 : 9), x, y + Math.round((hash(i, 2, s) - 0.5) * 4));
      x += large ? 22 : 17;
      i++;
    }
  };
  hedge(72, 200, 236, 330);
  hedge(248, 300, 236, 350);
  hedge(424, 480, 236, 360);

  // ── The fields along the bottom ──
  P(raisedBed("rice", 6, 2, 331), 52, 306);
  P(raisedBed("carrot", 5, 2, 332), 152, 306);
  P(raisedBed("daikon", 5, 2, 333), 300, 306);
  P(teaRows(76, 3, 334), 430, 300);
  P(moundShrub(335, "amber"), 6, 286);
  P(moundShrub(336, "olive", 12), 400, 300);

  // ── Filler: tall grass, flowers, twigs, pebbles ──
  const tufts: ReadonlyArray<readonly [number, number]> = [
    [92, 96],
    [160, 100],
    [262, 102],
    [304, 112],
    [188, 156],
    [250, 166],
    [178, 196],
    [204, 222],
    [242, 228],
    [120, 212],
    [96, 226],
    [30, 180],
    [16, 248],
    [62, 240],
    [312, 214],
    [292, 236],
    [420, 180],
    [470, 172],
    [384, 232],
    [350, 236],
    [248, 278],
    [202, 268],
    [118, 250],
    [24, 302],
    [474, 258],
    [404, 252],
    [62, 120],
    [136, 134],
    [300, 132],
    [326, 120],
  ];
  tufts.forEach(([x, y], i) => P(tallGrass(340 + i, i % 5 === 0 ? "gold" : "green"), x, y));
  const blooms: ReadonlyArray<readonly [number, number, number]> = [
    [70, 226, 0xf6d24a],
    [184, 212, 0xffffff],
    [254, 196, 0xf2b6c6],
    [312, 228, 0xd8394a],
    [42, 196, 0xf2b6c6],
    [418, 196, 0xf6d24a],
    [138, 226, 0xffffff],
  ];
  blooms.forEach(([x, y, color], i) => P(flowerClump(380 + i, color), x, y));
  const litter: ReadonlyArray<readonly [number, number]> = [
    [200, 182],
    [246, 210],
    [122, 140],
    [310, 140],
    [392, 166],
    [60, 136],
  ];
  litter.forEach(([x, y], i) => flat(i % 2 === 0 ? twig(390 + i) : pebbles(390 + i), x, y));

  // ── What moves: baked in for a still picture, animated otherwise ──
  const ambient: Ambient = {
    fire: at(398, 201),
    steam: [at(398, 182), at(452, 138), at(462, 138)],
    pond: { ...at(92, 162), rx: 15, ry: 6 },
    blossoms: [
      { ...at(470, 29), r: 10 },
      { ...at(24, 43), r: 14 },
      { ...at(332, 131), r: 14 },
      { ...at(364, 167), r: 10 },
    ],
    chickens: [
      { ...at(396, 126), flip: false },
      { ...at(472, 134), flip: true },
    ],
    dragonfly: at(104, 150),
    cat: [at(206, 250), at(246, 250)],
  };
  if (still) {
    P(steam(323), 400, 188);
    P(steam(326), 458, 130);
    P(chicken(327), 396, 126);
    P(chicken(328), 472, 134, { flip: true });
    P(dragonfly(), 104, 150);
    P(walkingCat(), 238, 232);
  }

  addCountryside(props, cols, rows, { ox, oy, seed, gateY: oy + 12 * TILE, headerY: top * TILE });

  const stations = Object.fromEntries(
    (Object.keys(SPOTS) as StationKind[]).map((kind) => [
      kind,
      (SPOTS[kind] ?? []).map(([x, y]) => at(x, y)),
    ]),
  ) as Record<StationKind, Spot[]>;

  return {
    scene: {
      grid: g.build(),
      seed,
      groundColors: WARM_GROUND,
      ink: WARM_INK,
      hideLabels: true,
      props,
      critters: [],
    },
    origin: { x: ox, y: oy },
    width: cols * TILE,
    height: rows * TILE,
    stations,
    paths: {
      nodes: PATH_NODES.map(([x, y]) => at(x, y)),
      edges: PATH_EDGES,
    },
    obstacles: OBSTACLES.map(([x, y, w, h]) => ({ x: x + ox, y: y + oy, w, h })),
    ambient,
  };
}

/**
 * Countryside around the farmstead, for windows wider or taller than it:
 * trees, blossom, shrubs and long grass on a loose grid, kept off the lane
 * that leads out through the gate. Deterministic for a seed.
 */
function addCountryside(
  props: PlacedProp[],
  cols: number,
  rows: number,
  o: {
    readonly ox: number;
    readonly oy: number;
    readonly seed: number;
    readonly gateY: number;
    /** The band at the top under the see-through header. */
    readonly headerY: number;
  },
): void {
  const width = cols * TILE;
  const height = rows * TILE;
  const core = {
    x0: o.ox - 6,
    y0: o.oy - 4,
    x1: o.ox + FARM_CORE.cols * TILE + 6,
    y1: o.oy + FARM_CORE.rows * TILE + 8,
  };
  const step = 34;
  for (let gy = 0; gy * step < height + step; gy++) {
    for (let gx = 0; gx * step < width + step; gx++) {
      const x = gx * step + Math.round((hash(gx, gy, o.seed + 1) - 0.5) * 18) + step / 2;
      const y = gy * step + Math.round((hash(gx, gy, o.seed + 2) - 0.5) * 16) + step / 2;
      // Keep the lane to the gate open.
      if (x < o.ox + 8 && Math.abs(y - o.gateY - 12) < 28) continue;
      if (x < -8 || y < 6 || x > width + 8 || y > height + 24) continue;
      // Under the header (and just below it) only low growth, so the header's
      // controls stay easy to read over the countryside.
      const underHeader = y < o.headerY + 22;
      const roll = underHeader ? 0.66 + hash(gx, gy, o.seed + 3) * 0.34 : hash(gx, gy, o.seed + 3);
      if (underHeader && hash(gx, gy, o.seed + 7) < 0.45) continue;
      const s = o.seed * 101 + gx * 31 + gy * 17;
      let sprite: Sprite;
      if (roll < 0.3)
        sprite = canopyTree(s, roll < 0.15 ? "green" : "olive", 0.8 + hash(gx, gy, 4) * 0.25);
      else if (roll < 0.42) sprite = sakuraTree(s, hash(gx, gy, 5) < 0.5);
      else if (roll < 0.66)
        sprite = moundShrub(
          s,
          (["green", "olive", "amber"] as const)[gx % 3] ?? "green",
          9 + Math.round(hash(gx, gy, 6) * 4),
        );
      else if (roll < 0.9) sprite = tallGrass(s, roll < 0.78 ? "green" : "gold");
      else sprite = flowerClump(s, ([0xf6d24a, 0xf2b6c6, 0xffffff] as const)[gy % 3] ?? 0xffffff);
      // Its whole picture must stay outside the farmstead, not just its foot:
      // a tree standing below the fields would grow up over them.
      const left = x - sprite.ax;
      const top = y - sprite.ay;
      const right = left + sprite.buf.width;
      const bottom = top + sprite.buf.height;
      if (right > core.x0 && left < core.x1 && bottom > core.y0 && top < core.y1) continue;
      props.push({ sprite, x, y });
    }
  }
}

/** Where a critter stands at `station` in its `slot`-th place (places repeat, nudged). */
export function farmSpot(farm: Farm, station: StationKind, slot: number): Spot {
  const spots = farm.stations[station];
  const base = spots[slot % spots.length] ?? farm.stations.lounge[0] ?? { x: 0, y: 0 };
  const lap = Math.floor(slot / Math.max(1, spots.length));
  return lap === 0 ? base : { x: base.x + lap * 6, y: base.y + lap * 3 };
}
