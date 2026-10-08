import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/providers/openai-realtime.ts",
    "src/providers/openai-codex-realtime.ts",
    "src/bridges/ezcoder-rpc.ts",
    "src/bridges/ezboss.ts",
  ],
  format: ["esm", "cjs"],
  // tsup injects baseUrl; scope TypeScript 6's deprecation allowance to declarations.
  dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
  clean: true,
  sourcemap: true,
});
