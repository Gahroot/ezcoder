import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface PackageJson {
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
}

describe("gg-boss Ink dependency", () => {
  it("pins Ink to match EZ Coder", () => {
    // Compare against ezcoder's actual spec instead of a hardcoded version:
    // both packages must resolve the SAME ink build (now the published
    // @kenkaiiii/ink fork via an npm alias) or their TUIs render differently.
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as PackageJson;
    const ezcoderPkg = JSON.parse(
      readFileSync(new URL("../../ezcoder/package.json", import.meta.url), "utf8"),
    ) as PackageJson;

    const ours = pkg.dependencies?.ink ?? pkg.devDependencies?.ink;
    const ezcoders = ezcoderPkg.dependencies?.ink ?? ezcoderPkg.devDependencies?.ink;
    expect(ours).toBeDefined();
    expect(ours).toBe(ezcoders);
  });
});
