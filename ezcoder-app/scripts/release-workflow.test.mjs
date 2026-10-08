import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../../.github/workflows/release.yml", import.meta.url),
  "utf8",
);
const buildStep =
  workflow
    .split(/(?=^ {6}- )/m)
    .find((step) => /^ {6}- name: Build framework packages\r?$/m.test(step)) ?? "";

describe("release framework build", () => {
  it("builds all retained packages in dependency order", () => {
    const commands = buildStep.match(/^ {10}pnpm --filter .+$/gm)?.map((line) => line.trim());
    expect(commands).toEqual([
      "pnpm --filter @prestyj/ai build",
      "pnpm --filter @prestyj/agent build",
      "pnpm --filter @prestyj/core build",
      "pnpm --filter @prestyj/pixel build",
      "pnpm --filter @prestyj/cli build",
    ]);
  });

  it("uses bash so intermediate failures stop Windows releases", () => {
    expect(buildStep).toMatch(/^ {8}shell: bash\s*$/m);
  });

  it("builds Pixel before the CLI in both clean-checkout CI jobs", () => {
    const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
    const steps = ci
      .split(/(?=^ {6}- )/m)
      .filter((step) => /^ {6}- name: Build framework packages\r?$/m.test(step));
    expect(steps).toHaveLength(2);
    for (const [index, step] of steps.entries()) {
      const commands = step.match(/^ {10}pnpm --filter .+$/gm)?.map((line) => line.trim());
      const expected = [
        "pnpm --filter @prestyj/ai build",
        "pnpm --filter @prestyj/agent build",
        "pnpm --filter @prestyj/core build",
        "pnpm --filter @prestyj/pixel build",
        "pnpm --filter @prestyj/cli build",
      ];
      if (index === 0) expected.push("pnpm --filter @prestyj/boss build");
      expect(commands).toEqual(expected);
      expect(step).toMatch(/^ {8}shell: bash\s*$/m);
    }
  });
});
