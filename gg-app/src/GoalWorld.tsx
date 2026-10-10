import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { FloorAgent } from "./critter-floor";
import { hashKey } from "./critter-sprites";
import { collectWorldAgents, type WorldAgent } from "./goal-world-agents";
import { FARM_CORE, buildFarm } from "./goal-farm-map";
import { drawFarm, paintFarm } from "./goal-farm-render";
import {
  createFarmWorld,
  farmIsMoving,
  resizeFarm,
  stepFarm,
  syncFarm,
  type FarmWorld,
} from "./goal-farm-sim";
import { TILE } from "./goal-map-ground";
import type { LiveToolEntry } from "./LiveToolPanel";
import { useMotionLevel } from "./window-motion";

/**
 * How many screen pixels each map pixel takes: exactly enough for the whole
 * farmstead to fill the part of the window below the header, whatever the
 * window's size, so everything is always in view. Not rounded to a whole
 * number: a whole-number scale jumps (a window a little smaller than full
 * screen dropped from 2× to 1×, halving the farm). The canvas is scaled with
 * nearest-neighbour sampling, so a fractional scale still reads as pixels.
 */
export function farmScale(width: number, height: number): number {
  const coreW = FARM_CORE.cols * TILE;
  const coreH = FARM_CORE.rows * TILE;
  return Math.max(0.5, Math.min(width / coreW, height / coreH));
}

/** How big a map (in tiles) covers the stage edge to edge, and what the header hides. */
export interface FarmFit {
  readonly scale: number;
  readonly cols: number;
  readonly rows: number;
  /** Tiles at the top under the see-through header. */
  readonly top: number;
}

/**
 * Fit the farm to a stage of `width × height` px with a header `headerPx` tall
 * over its top: the whole farmstead fits below the header, as big as it can
 * be, and countryside around it covers the rest of the stage.
 */
export function fitFarm(width: number, height: number, headerPx: number): FarmFit {
  const header = Math.max(0, Math.min(height / 2, headerPx));
  const scale = farmScale(width, height - header);
  const cell = TILE * scale;
  return {
    scale,
    cols: Math.max(FARM_CORE.cols, Math.ceil(width / cell)),
    rows: Math.max(FARM_CORE.rows, Math.ceil(height / cell)),
    top: Math.ceil(header / cell),
  };
}

/** What the farm shows, in words, for screen readers. */
export function describeWorld(agents: readonly WorldAgent[]): string {
  return agents
    .map((agent) => {
      const status =
        agent.status === "done" ? "done" : agent.status === "error" ? "stopped" : agent.detail;
      return `${agent.name}: ${status}.`;
    })
    .join(" ");
}

const reducedMotionQuery = (): boolean =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Rebuilding the farm costs ~0.15s, so a drag-resize waits until it settles. */
const REFIT_DELAY_MS = 140;

interface Props {
  /** The header the farm runs under; the farmstead keeps below it. */
  headerRef?: RefObject<HTMLElement | null>;
  goalId: string;
  running: boolean;
  liveTools: readonly LiveToolEntry[];
  waitingOnUser: boolean;
  workers: readonly FloorAgent[];
}

/**
 * A started Goal, seen from above as a little farm filling the window: GG
 * Goals and every worker it brings in are critters about the yard, travelling
 * (on foot, skateboard, motorbike, jetpack or teleport) to the place for
 * whatever they're doing: the bookcase to read, the laptop for the web, the
 * notes board to plan, the carpenter's bench to edit, the stove to run things,
 * the post box to ask you something, and the tea bench by the fire to wait.
 * The canvas is decoration; a visually hidden summary carries the same facts.
 */
export function GoalWorld({
  headerRef,
  goalId,
  running,
  liveTools,
  waitingOnUser,
  workers,
}: Props): React.ReactElement {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<FarmWorld | null>(null);
  const backgroundRef = useRef<HTMLCanvasElement | null>(null);
  const fitKeyRef = useRef("");
  const motion = useMotionLevel();
  const [reduced, setReduced] = useState(reducedMotionQuery);
  // Each goal keeps its own countryside, so returning to it feels like coming home.
  const seed = useMemo(() => hashKey(`goal-farm:${goalId}`) % 9973, [goalId]);

  const agents = useMemo(
    () => collectWorldAgents({ running, liveTools, waitingOnUser, workers }),
    [running, liveTools, waitingOnUser, workers],
  );
  const summary = useMemo(() => describeWorld(agents), [agents]);
  // The latest agents, for a farm built after they arrive (a stage that was
  // hidden at first gets its farm on its first resize).
  const agentsRef = useRef(agents);
  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (): void => setReduced(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  // Fit the farm to the stage: the whole farmstead in view below the header,
  // the map covering the stage edge to edge. The map is rebuilt only when its
  // tile size changes; the scale just restyles the canvas. A drag-resize
  // waits for the window to settle.
  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;
    let timer = 0;
    const fit = (): void => {
      const { clientWidth, clientHeight } = stage;
      if (clientWidth === 0 || clientHeight === 0) return;
      const f = fitFarm(clientWidth, clientHeight, headerRef?.current?.offsetHeight ?? 0);
      const key = `${seed}:${f.cols}x${f.rows}:${f.top}`;
      if (key !== fitKeyRef.current || !worldRef.current || !backgroundRef.current) {
        fitKeyRef.current = key;
        const farm = buildFarm({ cols: f.cols, rows: f.rows, top: f.top, seed });
        canvas.width = farm.width;
        canvas.height = farm.height;
        backgroundRef.current = paintFarm(farm);
        if (worldRef.current) resizeFarm(worldRef.current, farm);
        else {
          worldRef.current = createFarmWorld(farm, Math.random);
          syncFarm(worldRef.current, agentsRef.current, performance.now());
        }
      }
      // Scale the canvas up, and centre it so any overhang (under a tile) is
      // split between the edges.
      const w = Math.round(canvas.width * f.scale);
      const h = Math.round(canvas.height * f.scale);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      canvas.style.left = `${Math.round((clientWidth - w) / 2)}px`;
      canvas.style.top = `${Math.round((clientHeight - h) / 2)}px`;
    };
    fit();
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(fit, REFIT_DELAY_MS);
    });
    observer.observe(stage);
    // The header grows or shrinks (nav shown or hidden): re-fit then too.
    const header = headerRef?.current;
    if (header) observer.observe(header);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [seed, headerRef]);

  // Feed agent changes to the farm as they happen.
  useEffect(() => {
    const world = worldRef.current;
    if (world) syncFarm(world, agents, performance.now());
  }, [agents]);

  // One frame loop, and only while the window is in view. A hidden window
  // draws nothing; an unfocused or reduced-motion one is a still picture
  // (everyone where they are working, the fire and water at rest).
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    if (motion === "off") return;
    const still = reduced || motion !== "full";
    const paint = (now: number): void => {
      const world = worldRef.current;
      const background = backgroundRef.current;
      if (!world || !background) return;
      stepFarm(world, now, still);
      drawFarm(ctx, background, world, now, still ? 0 : now);
    };
    if (still) {
      paint(performance.now());
      const id = window.setInterval(() => paint(performance.now()), 600);
      return () => window.clearInterval(id);
    }
    // ~30fps while someone travels; ~10fps while the farm just idles (the
    // fire, the koi, the petals), which is all that pixel art needs.
    let frame = 0;
    let last = 0;
    const tick = (now: number): void => {
      const world = worldRef.current;
      const interval = world && farmIsMoving(world) ? 32 : 100;
      if (now - last >= interval) {
        last = now;
        paint(now);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [motion, reduced, seed]);

  return (
    <section className="goal-world" aria-label="Workers">
      <div ref={stageRef} className="goal-world-stage" aria-hidden="true">
        <canvas ref={canvasRef} className="goal-world-canvas" />
      </div>
      <p className="sr-only" aria-live="polite">
        {summary}
      </p>
    </section>
  );
}
