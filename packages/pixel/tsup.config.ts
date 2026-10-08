import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    // tsup injects baseUrl; scope TypeScript 6's deprecation allowance to declarations.
    dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
    clean: true,
    sourcemap: true,
    // Inject `import.meta.url` shim into CJS output — local-sqlite.ts and
    // install.ts both call `createRequire(import.meta.url)`, which is empty
    // under CJS without this.
    shims: true,
  },
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    sourcemap: true,
    clean: false,
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: ["src/browser.ts"],
    format: ["esm"],
    // tsup injects baseUrl; scope TypeScript 6's deprecation allowance to declarations.
    dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
    sourcemap: true,
    clean: false,
    platform: "browser",
    target: "es2020",
  },
  {
    entry: { "browser.iife": "src/browser.iife.ts" },
    format: ["iife"],
    globalName: "EZPixel",
    sourcemap: true,
    clean: false,
    platform: "browser",
    target: "es2020",
    minify: true,
  },
  {
    entry: ["src/deno.ts"],
    format: ["esm"],
    // tsup injects baseUrl; scope TypeScript 6's deprecation allowance to declarations.
    dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
    sourcemap: true,
    clean: false,
    platform: "neutral",
    target: "es2022",
  },
  {
    entry: ["src/workers.ts"],
    format: ["esm"],
    // tsup injects baseUrl; scope TypeScript 6's deprecation allowance to declarations.
    dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
    sourcemap: true,
    clean: false,
    platform: "neutral",
    target: "es2022",
  },
]);
