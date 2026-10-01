// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NolanFace } from "./NolanFace";
import { NolanPowerBanner } from "./NolanPowerBanner";

const layers = (container: HTMLElement): string[] =>
  [...container.querySelectorAll<HTMLImageElement>(".nolan-face-layer")].map((img) =>
    [...img.classList].filter((c) => c !== "nolan-face-layer").join(" "),
  );

describe("NolanFace", () => {
  it("idles in chat with a blink, and adds a talking mouth while streaming", () => {
    const idle = render(<NolanFace mood="chat" />);
    expect(layers(idle.container)).toEqual(["nolan-face-base", "nolan-face-blink"]);

    const talking = render(<NolanFace mood="chat" talking />);
    expect(layers(talking.container)).toEqual([
      "nolan-face-base",
      "nolan-face-talk",
      "nolan-face-blink",
    ]);
    expect(talking.container.querySelector(".nolan-face-talking")).not.toBeNull();
  });

  it("wakes up for on and nods off, with a z, for off", () => {
    const on = render(<NolanFace mood="on" />);
    expect(layers(on.container)).toEqual(["nolan-face-sleepy", "nolan-face-happy"]);
    expect(on.container.querySelector(".nolan-face-z")).toBeNull();

    const off = render(<NolanFace mood="off" />);
    expect(layers(off.container)).toEqual(["nolan-face-base", "nolan-face-sleepy"]);
    expect(off.container.querySelector(".nolan-face-z")).not.toBeNull();
  });
});

describe("NolanPowerBanner", () => {
  it.each([
    ["on", "Nolan is on."],
    ["off", "Nolan is off."],
  ] as const)("shows Nolan's %s face beside the words", (mode, text) => {
    const { container } = render(<NolanPowerBanner mode={mode} onDone={() => undefined} />);
    expect(container.querySelector(`.nolan-power-banner .nolan-face-${mode}`)).not.toBeNull();
    expect(container.textContent).toContain(text);
  });

  // jsdom has no AnimationEvent, so React listens for the prefixed name there.
  const animationEnd = (el: Element): boolean =>
    fireEvent(el, new Event("webkitAnimationEnd", { bubbles: true }));

  it("ends on the banner's own animation, not the face's", () => {
    const onDone = vi.fn();
    const { container } = render(<NolanPowerBanner mode="off" onDone={onDone} />);
    const face = container.querySelector(".nolan-face");
    const banner = container.querySelector(".nolan-power-banner");
    if (!face || !banner) throw new Error("banner not rendered");

    animationEnd(face);
    expect(onDone).not.toHaveBeenCalled();

    animationEnd(banner);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
