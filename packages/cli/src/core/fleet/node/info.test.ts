import { describe, expect, it } from "vitest";
import { parseVmStat } from "./info.js";

describe("parseVmStat", () => {
  it("counts free, inactive, speculative and purgeable pages", () => {
    const text =
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:  10.\nPages active:  99.\nPages inactive:  20.\nPages speculative:  5.\nPages purgeable:  1.\n";
    expect(parseVmStat(text)).toBe(36 * 16384);
    expect(parseVmStat("nonsense")).toBeUndefined();
  });
});
