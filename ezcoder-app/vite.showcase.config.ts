import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Standalone Vite config for the screenshot showcase. It swaps every
// `@tauri-apps/*` module for `showcase/tauri-mock.ts` so the real screen
// components render with canned data in a plain (headless) browser. Run with
// `pnpm showcase`; open /showcase.html?screen=<name>.

const mock = fileURLToPath(new URL("./showcase/tauri-mock.ts", import.meta.url));

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
  },
  resolve: {
    alias: [
      { find: /^@tauri-apps\/api\/core$/, replacement: mock },
      { find: /^@tauri-apps\/api\/webviewWindow$/, replacement: mock },
      { find: /^@tauri-apps\/api\/app$/, replacement: mock },
      { find: /^@tauri-apps\/plugin-log$/, replacement: mock },
      { find: /^@tauri-apps\/plugin-opener$/, replacement: mock },
      { find: /^@tauri-apps\/plugin-dialog$/, replacement: mock },
      { find: /^@tauri-apps\/plugin-process$/, replacement: mock },
      { find: /^@tauri-apps\/plugin-updater$/, replacement: mock },
    ],
  },
});
