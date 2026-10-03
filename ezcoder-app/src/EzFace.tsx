import { renderEzFace, type EzFaceFrame, type EzFaceMood } from "./ez-face";

// The faces never change, so build each SVG once rather than on every render.
const FRAMES: Readonly<Record<EzFaceFrame, string>> = {
  ready: renderEzFace("ready"),
  blink: renderEzFace("blink"),
  happy: renderEzFace("happy"),
  curious: renderEzFace("curious"),
  worried: renderEzFace("worried"),
  sad: renderEzFace("sad"),
  shocked: renderEzFace("shocked"),
};

/**
 * EZ Coder's little robot (see ez-face.ts) showing a mood. Ready blinks now
 * and then; the other moods hold still. `size` is the edge in CSS px.
 * Decorative: the text beside it carries the meaning.
 */
export function EzFace({
  mood,
  size = 14,
}: {
  mood: EzFaceMood;
  size?: number;
}): React.ReactElement {
  return (
    <span
      className={`ez-face ez-face-${mood}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <img className="ez-face-layer" src={FRAMES[mood]} alt="" draggable={false} />
      {mood === "ready" && (
        <img className="ez-face-layer ez-face-blink" src={FRAMES.blink} alt="" draggable={false} />
      )}
    </span>
  );
}
