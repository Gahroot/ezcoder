import { renderNolanFace, type NolanFaceFrame } from "./nolan-face";

/**
 * Where the face is shown, which picks its expressions and choreography:
 * - `chat`: the gutter of a Nolan reply. Idles with a blink and, while the reply
 *   streams in, talks.
 * - `on`: the "Nolan is on." banner. Wakes up: eyes shut, then a happy hop.
 * - `off`: the "Nolan is off." banner. Nods off: eyes close, he sinks, a "z" drifts up.
 */
export type NolanFaceMood = "chat" | "on" | "off";

interface Props {
  mood: NolanFaceMood;
  /** Chat only: the reply is still streaming, so his mouth moves. */
  talking?: boolean;
}

// The expressions never change, so build each SVG once rather than on every
// streamed token.
const FRAMES: Readonly<Record<NolanFaceFrame, string>> = {
  base: renderNolanFace("base"),
  blink: renderNolanFace("blink"),
  talk: renderNolanFace("talk"),
  happy: renderNolanFace("happy"),
  sleepy: renderNolanFace("sleepy"),
};

/** Stacked bottom to top; CSS fades the upper layers in and out over the first. */
function layersFor(mood: NolanFaceMood, talking: boolean): readonly NolanFaceFrame[] {
  switch (mood) {
    case "on":
      return ["sleepy", "happy"];
    case "off":
      return ["base", "sleepy"];
    case "chat":
      return talking ? ["base", "talk", "blink"] : ["base", "blink"];
  }
}

/** Nolan's little animated pixel face (see nolan-face.ts). Decorative. */
export function NolanFace({ mood, talking = false }: Props): React.ReactElement {
  return (
    <span
      className={`nolan-face nolan-face-${mood}${talking ? " nolan-face-talking" : ""}`}
      aria-hidden="true"
    >
      {layersFor(mood, talking).map((frame) => (
        <img
          key={frame}
          className={`nolan-face-layer nolan-face-${frame}`}
          src={FRAMES[frame]}
          alt=""
          draggable={false}
        />
      ))}
      {mood === "off" && <span className="nolan-face-z">z</span>}
    </span>
  );
}
