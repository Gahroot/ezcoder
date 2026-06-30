// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useNolanMentor } from "./useNolanMentor";
import type { Item } from "./App";
import type { SidecarEvent } from "./agent";

/**
 * Drive the hook with a real (mutable) items array + monotonic id minter, mirroring
 * how App wires it. setItems runs synchronously here, so transcript appends are
 * observable immediately; the hook's own React state (nolanRunning, nolanTokens, …) is
 * read off result.current after an act() flush.
 */
function setup() {
  let items: Item[] = [];
  let id = 0;
  const setItems = (u: Item[] | ((prev: Item[]) => Item[])): void => {
    items = typeof u === "function" ? u(items) : u;
  };
  const nextId = (): number => ++id;
  const hook = renderHook(() => useNolanMentor({ setItems, nextId }));
  return { hook, getItems: () => items };
}

const ev = (type: string, data: Record<string, unknown> = {}): SidecarEvent =>
  ({ type, data }) as SidecarEvent;

describe("useNolanMentor", () => {
  it("nolan_text_delta appends a single kind:'ken' item via setItems", () => {
    const { hook, getItems } = setup();
    act(() => {
      hook.result.current.handleNolanEvent(ev("nolan_text_delta", { text: "hello" }));
    });
    const items = getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "ken", text: "hello" });

    // A second delta appends to the SAME bubble, not a new item.
    act(() => {
      hook.result.current.handleNolanEvent(ev("nolan_text_delta", { text: " world" }));
    });
    const after = getItems();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ kind: "ken", text: "hello world" });
  });

  it("nolan_run_start flips nolanRunning true and resets tokens", () => {
    const { hook } = setup();
    // Seed some tokens first so the reset is observable.
    act(() => {
      hook.result.current.handleNolanEvent(ev("nolan_turn_end", { usage: { outputTokens: 42 } }));
    });
    expect(hook.result.current.nolanTokens).toBe(42);

    act(() => {
      hook.result.current.handleNolanEvent(ev("nolan_run_start"));
    });
    expect(hook.result.current.nolanRunning).toBe(true);
    expect(hook.result.current.nolanTokens).toBe(0);
    expect(hook.result.current.nolanRunStartTs).toBeTypeOf("number");
  });

  it("nolan_turn_end accumulates outputTokens across turns", () => {
    const { hook } = setup();
    act(() => {
      hook.result.current.handleNolanEvent(ev("nolan_run_start"));
    });
    act(() => {
      hook.result.current.handleNolanEvent(ev("nolan_turn_end", { usage: { outputTokens: 10 } }));
    });
    expect(hook.result.current.nolanTokens).toBe(10);
    act(() => {
      hook.result.current.handleNolanEvent(ev("nolan_turn_end", { usage: { outputTokens: 5 } }));
    });
    expect(hook.result.current.nolanTokens).toBe(15);
  });

  it("nolan_error pushes a kind:'error' item and stops running", () => {
    const { hook, getItems } = setup();
    act(() => {
      hook.result.current.handleNolanEvent(ev("nolan_run_start"));
    });
    act(() => {
      hook.result.current.handleNolanEvent(ev("nolan_error", { message: "boom" }));
    });
    const items = getItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "error" });
    expect((items[0] as { text: string }).text).toContain("boom");
    expect(hook.result.current.nolanRunning).toBe(false);
  });

  it("returns true for nolan events and false for a non-nolan event", () => {
    const { hook, getItems } = setup();
    let nolanHandled = false;
    let buildHandled = true;
    act(() => {
      nolanHandled = hook.result.current.handleNolanEvent(ev("nolan_run_start"));
      buildHandled = hook.result.current.handleNolanEvent(ev("text_delta", { text: "build" }));
    });
    expect(nolanHandled).toBe(true);
    expect(buildHandled).toBe(false);
    // A non-ken event must NOT have touched the transcript.
    expect(getItems()).toHaveLength(0);
  });
});
