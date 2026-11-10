// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NolanActivityBar } from "./NolanActivityBar";
import { theme } from "./theme";

const baseProps = {
  runStartTs: null,
  tokens: 1234,
};

describe("NolanActivityBar", () => {
  it("uses the listening orb and shimmer with Nolan's existing color", () => {
    const { container } = render(<NolanActivityBar {...baseProps} />);
    const orb = container.querySelector("canvas");
    expect(orb?.getAttribute("aria-label")).toBe("Listening…");
    expect(orb?.getAttribute("aria-hidden")).toBe("true");
    expect(orb?.style.width).toBe("20px");
    const filter = container.querySelector("filter");
    expect(orb?.style.filter).toBe(`url("#${filter?.id}")`);
    const flood = container.querySelector<SVGElement>("feFlood");
    expect(flood?.style.getPropertyValue("flood-color")).toBe(theme.nolan);
    const label = screen.getByText("Nolan is thinking…");
    expect(label.classList.contains("shimmer-text")).toBe(true);
    expect(label.style.getPropertyValue("--shimmer-base")).toBe(theme.nolan);
  });

  it("matches the main bar's running row, with Stop left to the composer's send key", () => {
    const { container } = render(<NolanActivityBar {...baseProps} />);
    expect(container.querySelector(".task-activity > .statusrow.running")).toBeTruthy();
    expect(screen.getByTitle("Output tokens").textContent).toBe(" · 1.2k tok");
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /tool panel/ })).toBeNull();
  });

  it("shows the tool panel chevron, like the main bar", () => {
    const onToggleTools = vi.fn();
    render(<NolanActivityBar {...baseProps} toolsHidden onToggleTools={onToggleTools} />);
    const chevron = screen.getByRole("button", { name: "Show tool panel" });
    fireEvent.click(chevron);
    expect(onToggleTools).toHaveBeenCalledOnce();
  });
});
