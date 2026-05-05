import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

/**
 * Resolve the bundled splash.mp3. The build script copies the asset from
 * `assets/` to `dist/` so this path lands inside the published tarball when
 * users `npm i -g`. Falls back to the source location during local dev where
 * the build hasn't happened yet (rare — tsc runs every iteration).
 */
function splashAssetPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dist = path.join(here, "splash.mp3");
  if (fs.existsSync(dist)) return dist;
  // Dev fallback: dist/audio.js → ../assets/splash.mp3 in the source tree.
  const dev = path.join(here, "..", "assets", "splash.mp3");
  return dev;
}

/**
 * Fire a candidate player as a detached child. Returns true if the spawn
 * actually started successfully (no immediate ENOENT). The audio process
 * outlives the splash unmount so playback can finish on its own. Stdio is
 * redirected to /dev/null so the player can't pollute the TUI.
 */
function trySpawn(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    try {
      const child = spawn(cmd, args, {
        detached: true,
        stdio: "ignore",
      });
      child.once("error", () => {
        // ENOENT (binary not installed) or permission failure — let the next
        // candidate take a turn. Don't surface to the user.
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
      });
      child.once("spawn", () => {
        if (!resolved) {
          resolved = true;
          // Detach so the parent process exiting doesn't kill the audio.
          child.unref();
          resolve(true);
        }
      });
      // Some Node versions fire neither immediately. After 50ms with no error,
      // assume success — the spawn went through.
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          child.unref();
          resolve(true);
        }
      }, 50);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Cross-platform fire-and-forget MP3 playback. Tries the most likely binary
 * for the host OS first, then a small chain of common Linux fallbacks.
 *
 * Platform notes:
 *  - macOS:   `afplay` ships with the OS, always works for MP3.
 *  - Windows: PowerShell + WPF MediaPlayer is built-in and supports MP3 via
 *             DirectShow / MediaFoundation. Doesn't pop up a window because
 *             the script runs sync inside powershell.exe with -NoProfile.
 *  - Linux:   No single guaranteed binary. Try mpv → ffplay → mpg123 → cvlc.
 *             If none are installed, give up silently — Linux desktop audio
 *             is fragmented enough that we don't want to bloat the package
 *             with a bundled player.
 */
export async function playSplashAudio(): Promise<void> {
  const file = splashAssetPath();
  if (!fs.existsSync(file)) return;
  const platform = process.platform;

  if (platform === "darwin") {
    await trySpawn("afplay", [file]);
    return;
  }

  if (platform === "win32") {
    // Escape single quotes in the path for the PowerShell -Command argument.
    const safe = file.replace(/'/g, "''");
    const script = [
      "Add-Type -AssemblyName presentationCore;",
      "$p = New-Object System.Windows.Media.MediaPlayer;",
      `$p.Open([uri]'${safe}');`,
      "$p.Play();",
      // Sleep so the powershell process stays alive long enough to actually
      // play the clip (MediaPlayer is async; if powershell exits the GC
      // tears the player down before sound plays). Match clip length + a beat.
      "Start-Sleep -Seconds 5;",
    ].join(" ");
    await trySpawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", script]);
    return;
  }

  // Linux + everything else: walk the candidates.
  const linuxCandidates: { cmd: string; args: string[] }[] = [
    { cmd: "mpv", args: ["--really-quiet", "--no-video", file] },
    { cmd: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "quiet", file] },
    { cmd: "mpg123", args: ["-q", file] },
    { cmd: "mpg321", args: ["-q", file] },
    { cmd: "cvlc", args: ["--play-and-exit", "--quiet", file] },
    { cmd: "paplay", args: [file] },
  ];
  for (const c of linuxCandidates) {
    const ok = await trySpawn(c.cmd, c.args);
    if (ok) return;
  }
}
