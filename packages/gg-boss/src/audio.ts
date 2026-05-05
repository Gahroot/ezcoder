import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

/**
 * Parse an MP3's duration in milliseconds by walking its frame headers. Pure
 * JS, no native deps. Handles CBR (sums frame sizes vs sample rate) and VBR
 * with a Xing/Info header (reads totalFrames directly). Returns null on any
 * parse failure — caller falls back to a sensible default in that case.
 *
 * Why we do this at runtime: the splash needs to stay visible for the full
 * audio duration so the user isn't dumped into the chat mid-jingle. Bundling
 * a hardcoded constant works until someone swaps the asset and forgets to
 * update the number; reading it from the file is robust to that.
 */
function readMp3DurationMs(file: string): number | null {
  try {
    const buf = fs.readFileSync(file);
    // Skip ID3v2 tag if present — first 10 bytes are "ID3" + version + flags
    // + size (synchsafe). Frame headers start after the tag.
    let i = 0;
    if (buf.length >= 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
      const tagSize =
        ((buf[6]! & 0x7f) << 21) |
        ((buf[7]! & 0x7f) << 14) |
        ((buf[8]! & 0x7f) << 7) |
        (buf[9]! & 0x7f);
      i = 10 + tagSize;
    }
    // Find first MPEG audio sync (11 bits set: 0xFFE).
    while (i + 4 < buf.length) {
      if (buf[i] === 0xff && (buf[i + 1]! & 0xe0) === 0xe0) break;
      i++;
    }
    if (i + 4 >= buf.length) return null;
    const h1 = buf[i + 1]!;
    const h2 = buf[i + 2]!;
    const versionBits = (h1 >> 3) & 0x03; // 11 = MPEG-1, 10 = MPEG-2, 00 = MPEG-2.5
    const layerBits = (h1 >> 1) & 0x03; // 01 = Layer III
    const bitrateIdx = (h2 >> 4) & 0x0f;
    const sampleRateIdx = (h2 >> 2) & 0x03;
    const padding = (h2 >> 1) & 0x01;
    const isMpeg1 = versionBits === 0x03;
    if (layerBits !== 0x01) return null; // only Layer III is bundled
    // Bitrate kbps tables for MPEG-1/2 Layer III
    const BR_V1: number[] = [
      0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1,
    ];
    const BR_V2: number[] = [
      0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1,
    ];
    const SR_V1: number[] = [44100, 48000, 32000, -1];
    const SR_V2: number[] = [22050, 24000, 16000, -1];
    const SR_V25: number[] = [11025, 12000, 8000, -1];
    const bitrate = (isMpeg1 ? BR_V1 : BR_V2)[bitrateIdx];
    const sampleRate = (isMpeg1 ? SR_V1 : versionBits === 0x02 ? SR_V2 : SR_V25)[sampleRateIdx];
    if (!bitrate || bitrate <= 0 || !sampleRate || sampleRate <= 0) return null;
    const samplesPerFrame = isMpeg1 ? 1152 : 576;

    // Look for a Xing/Info header inside the first frame (offset depends on
    // channel mode). If present, totalFrames * samplesPerFrame / sampleRate
    // gives an accurate VBR duration.
    const sideInfoOffset = isMpeg1 ? (((h2 >> 6) & 0x03) === 0x03 ? 17 : 32) : 9;
    const xingTagOffset = i + 4 + sideInfoOffset;
    if (xingTagOffset + 8 < buf.length) {
      const tag = buf.toString("ascii", xingTagOffset, xingTagOffset + 4);
      if (tag === "Xing" || tag === "Info") {
        const flags = buf.readUInt32BE(xingTagOffset + 4);
        if (flags & 0x01) {
          // totalFrames is the next 32-bit BE
          const totalFrames = buf.readUInt32BE(xingTagOffset + 8);
          if (totalFrames > 0) {
            return Math.round((totalFrames * samplesPerFrame * 1000) / sampleRate);
          }
        }
      }
    }

    // CBR fallback: bytes / (bitrate*1000/8) → seconds.
    const audioBytes = buf.length - i;
    const seconds = audioBytes / ((bitrate * 1000) / 8);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    void padding; // padding affects per-frame size, immaterial at file scale
    return Math.round(seconds * 1000);
  } catch {
    return null;
  }
}

/**
 * Duration of the bundled splash audio, in milliseconds. Read once from the
 * actual file so swapping the asset Just Works without anyone having to
 * remember to bump a constant. Falls back to 1500ms if parsing fails.
 */
export function getSplashAudioDurationMs(): number {
  const ms = readMp3DurationMs(splashAssetPath());
  return ms && ms > 0 ? ms : 1500;
}

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
