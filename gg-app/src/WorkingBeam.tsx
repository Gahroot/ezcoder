import { BorderBeam } from "border-beam";

/** Decorative overlay: never wraps or remounts the editable field or its controls. */
export function WorkingBeam({
  active,
  size = "md",
}: {
  active: boolean;
  size?: "md" | "sm";
}): React.ReactElement | null {
  if (!active) return null;

  return (
    <BorderBeam
      className={`working-beam working-beam-${size}`}
      size={size}
      colorVariant="colorful"
      strength={0.7}
      theme="dark"
      aria-hidden="true"
    >
      <div className="working-beam-surface" />
    </BorderBeam>
  );
}
