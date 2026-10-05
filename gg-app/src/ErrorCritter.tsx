import { useMemo } from "react";
import { CRITTERS, CRITTER_CELLS, renderCritterFrame, renderPixelGrid } from "./critter-sprites";
import type { ChatErrorReason } from "./chat-error";

export function ErrorCritter({
  reason,
  animate,
}: {
  reason?: ChatErrorReason | undefined;
  animate: boolean;
}): React.ReactElement | null {
  const name =
    reason === "capability"
      ? "owl"
      : reason === "model_access" || reason === "auth"
        ? "fox"
        : reason === "usage_limit" || reason === "rate_limit"
          ? "bee"
          : "cat";
  const sprite = useMemo(() => {
    const critter = CRITTERS.find((candidate) => candidate.id === name);
    if (!critter) return undefined;
    let left = CRITTER_CELLS,
      top = CRITTER_CELLS,
      right = 0,
      bottom = 0;
    for (const [y, row] of critter.rows.entries()) {
      for (const [x, cell] of [...row].entries()) {
        if (cell === "." || !critter.palette[cell]) continue;
        left = Math.min(left, x);
        right = Math.max(right, x + 1);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y + 1);
      }
    }
    const eyes =
      name === "owl"
        ? [
            [2, 6, 3, 3],
            [8, 6, 4, 3],
          ]
        : name === "bee"
          ? [
              [4, 5, 2, 2],
              [9, 5, 2, 2],
            ]
          : [
              [4, 7, 2, 2],
              [9, 7, 2, 2],
            ];
    const rows = Array.from({ length: CRITTER_CELLS }, () =>
      Array<string>(CRITTER_CELLS).fill("."),
    );
    for (const eye of eyes) {
      const [x, y, width, height] = eye;
      if (x == null || y == null || width == null || height == null) continue;
      for (let row = y; row < y + height; row++) {
        for (let col = x; col < x + width; col++) {
          const cells = rows[row];
          if (cells) cells[col] = row === y + 1 ? "K" : "B";
        }
      }
    }
    return {
      open: renderCritterFrame(critter, 0),
      blink: renderPixelGrid(
        rows.map((row) => row.join("")),
        critter.palette,
        { width: CRITTER_CELLS, height: CRITTER_CELLS },
      ),
      x: CRITTER_CELLS - left - right,
      y: CRITTER_CELLS - top - bottom,
    };
  }, [name]);
  if (!sprite) return null;
  return (
    <span className="chat-error-critter" aria-hidden="true" data-critter={name}>
      <span
        className="chat-error-art"
        style={{ transform: `translate(${sprite.x}px, ${sprite.y}px)` }}
      >
        <img src={sprite.open} alt="" draggable={false} />
        <img
          src={sprite.blink}
          alt=""
          draggable={false}
          className={`chat-error-blink${animate ? " is-animated" : ""}`}
        />
      </span>
    </span>
  );
}
