import type { NolanFace } from "./goal-nolan-talk";
import { formatMonthYear, type ShipLog } from "./about-ship-log";

export const SKOOL_URL = "https://prestyj.com";
export const YOUTUBE_URL = "https://prestyj.com";

/**
 * When EZ Coder began: the repo's first commit, as the command-line tool. The
 * desktop app came later; its first release is the changelog's oldest entry.
 */
export const EZ_CODER_STARTED = "2026-03-04";

/** One thing Nolan says in his box, with the face he says it with. */
export interface NolanSay {
  readonly face: NolanFace;
  readonly text: string;
}

/**
 * What Nolan says on the About page: a few plain sentences, each short enough to
 * fit his box's three lines.
 */
export function aboutLines(log: ShipLog): readonly NolanSay[] {
  return [
    {
      face: "happy",
      text: "Hey, I'm Nolan. I built EZ Coder, the coding agent you're using right now.",
    },
    {
      face: "neutral",
      text: `It started as a command-line tool in ${formatMonthYear(EZ_CODER_STARTED)}. This desktop app came along in ${formatMonthYear(log.firstDate)}.`,
    },
    {
      face: "thinking",
      text: "I keep improving it most weeks, and I show how I build things like this on YouTube.",
    },
    {
      face: "happy",
      text: "Want to learn to build with AI too? Come join me on Skool. Happy to help you get going.",
    },
  ];
}
