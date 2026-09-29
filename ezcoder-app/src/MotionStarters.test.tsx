// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MOTION_STARTERS } from "./motion-starters";
import { MotionStarters } from "./MotionStarters";

afterEach(() => {
  cleanup();
});

describe("MotionStarters", () => {
  it("offers the available recipe and narrow edits without promising missing styles", () => {
    expect(MOTION_STARTERS.map(({ label }) => label)).toEqual([
      "Make a split-text opener",
      "Edit my Motion project",
    ]);
    expect(MOTION_STARTERS[0].prompt).toContain("mixkit-split-text-617");
    expect(MOTION_STARTERS[0].prompt).toContain("Preserve its source choreography");
    expect(MOTION_STARTERS[1].prompt).toContain("Change only what I request");
    expect(MOTION_STARTERS[1].prompt).toContain("new versioned filename");
    for (const starter of MOTION_STARTERS) {
      expect(starter.prompt).not.toMatch(/30-second|launch kit|new art direction/i);
    }
  });
  it.each(MOTION_STARTERS)(
    "fills the composer with $label without submitting",
    ({ label, prompt }) => {
      const onPick = vi.fn();
      const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
      render(
        <form onSubmit={onSubmit}>
          <MotionStarters onPick={onPick} />
        </form>,
      );

      expect(screen.getAllByRole("button")).toHaveLength(MOTION_STARTERS.length);
      expect(onPick).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: label }));

      expect(onPick).toHaveBeenCalledOnce();
      expect(onPick).toHaveBeenCalledWith(prompt);
      expect(onSubmit).not.toHaveBeenCalled();
    },
  );
});
