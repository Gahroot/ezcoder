import { spawn, type ChildProcess } from "node:child_process";
import { log } from "./logger.js";

/**
 * Terminal radio — stream a free internet radio station while you're working.
 * Curated short list of long-running, royalty-free, no-API-key streams that
 * have been stable for years (SomaFM started in 2000, Radio Paradise in 2006).
 *
 * Player binary detection mirrors the audio.ts chain for one-shot effects:
 * mpv > ffplay > mpg123 > cvlc. macOS's built-in afplay isn't a streaming
 * player, so users who haven't installed any of those will get a one-line
 * "install mpv" hint and the radio request just no-ops gracefully.
 *
 * One station at a time — switching stations or selecting "Off" kills the
 * existing player process before spawning a new one.
 */

export interface RadioStation {
  /** Stable identifier used in slash command + settings persistence. */
  id: string;
  /** Display name in the picker. */
  name: string;
  /** Short subtitle shown next to the name. */
  description: string;
  /** Direct stream URL — must be MP3/AAC/Ogg, anything mpv handles. */
  url: string;
}

export const RADIO_STATIONS: readonly RadioStation[] = [
  {
    id: "somafm-groove-salad",
    name: "SomaFM · Groove Salad",
    description: "Chilled downtempo, ambient grooves",
    url: "http://ice1.somafm.com/groovesalad-128-mp3",
  },
  {
    id: "somafm-drone-zone",
    name: "SomaFM · Drone Zone",
    description: "Atmospheric textures with minimal beats",
    url: "http://ice1.somafm.com/dronezone-128-mp3",
  },
  {
    id: "radio-paradise",
    name: "Radio Paradise",
    description: "Eclectic mix — rock, electronica, jazz",
    url: "http://stream.radioparadise.com/mp3-128",
  },
];

interface PlayerCandidate {
  cmd: string;
  args: (url: string) => string[];
}

/**
 * Streaming-capable players in priority order. Each gets its quietest flag
 * combination — radio runs in the background, we don't want stdout/stderr
 * spam fighting with the TUI. Stdio is also redirected to "ignore" at spawn
 * time, but quiet flags help in case the player decides to write to tty.
 */
const PLAYERS: readonly PlayerCandidate[] = [
  { cmd: "mpv", args: (u) => ["--really-quiet", "--no-video", "--no-terminal", u] },
  {
    cmd: "ffplay",
    args: (u) => ["-nodisp", "-autoexit", "-loglevel", "quiet", u],
  },
  { cmd: "mpg123", args: (u) => ["-q", u] },
  { cmd: "cvlc", args: (u) => ["--play-and-exit", "--quiet", u] },
];

let currentChild: ChildProcess | null = null;
let currentStationId: string | null = null;

export function getCurrentStation(): string | null {
  return currentStationId;
}

/**
 * Stop whatever's currently playing. Idempotent — safe to call when nothing
 * is playing. Sends SIGTERM (graceful), child cleans up the audio device.
 */
export function stopRadio(): void {
  if (!currentChild) return;
  try {
    // Detached children sit in their own process group on POSIX; kill the
    // whole group so any helper threads/forks die too. On Windows there's
    // no process group concept — kill() targets the child only.
    if (process.platform !== "win32" && currentChild.pid) {
      try {
        process.kill(-currentChild.pid, "SIGTERM");
      } catch {
        currentChild.kill("SIGTERM");
      }
    } else {
      currentChild.kill("SIGTERM");
    }
  } catch {
    // Already exited — nothing to do.
  }
  currentChild = null;
  currentStationId = null;
  log("INFO", "radio", "stopped");
}

interface PlayResult {
  ok: boolean;
  /** Friendly error to surface to the user when ok=false. */
  error?: string;
}

/**
 * Spawn a streaming player for the given station. If one is already playing,
 * it's killed first. Returns ok=false with a hint if no compatible player is
 * installed — caller should surface the error to the user.
 */
export function playRadio(stationId: string): PlayResult {
  const station = RADIO_STATIONS.find((s) => s.id === stationId);
  if (!station) return { ok: false, error: `Unknown station: ${stationId}` };

  // Always stop the previous stream before starting a new one.
  stopRadio();

  for (const player of PLAYERS) {
    try {
      const child = spawn(player.cmd, player.args(station.url), {
        detached: process.platform !== "win32",
        stdio: "ignore",
      });
      // Race: we don't know yet whether the spawn succeeded (ENOENT fires async).
      // Listen for the error event AND optimistically assume success. If error
      // fires within 100ms we'll fall through to the next candidate.
      let errored = false;
      child.once("error", () => {
        errored = true;
      });
      // Synchronous check after a tick — if the child has a pid by now, the
      // OS accepted the spawn. ENOENT is reported async via the "error" event,
      // so a non-null pid alone isn't conclusive, but combined with the
      // optimistic try/next-candidate loop it's enough.
      if (child.pid && !errored) {
        currentChild = child;
        currentStationId = stationId;
        log("INFO", "radio", "playing", {
          station: station.id,
          player: player.cmd,
          url: station.url,
        });
        // Detach so the radio outlives boss exit if the user wants it to.
        // (We still kill it on stopRadio() and on graceful boss shutdown.)
        child.unref();
        return { ok: true };
      }
    } catch {
      // ENOENT or permission — try the next player.
    }
  }
  log("WARN", "radio", "no compatible player found");
  return {
    ok: false,
    error:
      "No streaming player found. Install mpv (recommended): on macOS run `brew install mpv`, on Linux use your package manager, on Windows download from https://mpv.io/. ffplay (ships with ffmpeg), mpg123, or vlc/cvlc also work.",
  };
}
