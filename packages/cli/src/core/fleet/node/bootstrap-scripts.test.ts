import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = fileURLToPath(new URL("../../../../scripts/fleet/", import.meta.url));
const scripts = ["bootstrap-node-linux.sh", "bootstrap-node-macos.sh"];

// The scripts are bash for Linux/WSL2/macOS; Windows CI has no bash we can rely on.
describe.skipIf(process.platform === "win32")(
  "fleet bootstrap scripts (bash; skipped on Windows, which runs nodes inside WSL2)",
  () => {
    for (const name of scripts) {
      const file = path.join(dir, name);

      it(`${name} parses`, () => {
        const r = spawnSync("bash", ["-n", file], { encoding: "utf8" });
        expect(r.stderr).toBe("");
        expect(r.status).toBe(0);
      });

      it(`${name} --dry-run changes nothing and prints every step`, () => {
        const r = spawnSync("bash", [file, "--dry-run", "--name", "box", "--labels", "gpu"], {
          encoding: "utf8",
          // Usually no node on this PATH, so the Node install step shows up too.
          env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent-home", TMPDIR: "/tmp" },
        });
        expect(r.stderr).toBe("");
        expect(r.status).toBe(0);
        if (r.stdout.includes("installing Node")) {
          expect(r.stdout).toContain("[dry-run] bash /tmp/nvm-install-v0.40.1.sh");
          expect(r.stdout).toContain("[dry-run] nvm install 22");
        } else {
          expect(r.stdout).toMatch(/==> Node v\d+/);
        }
        expect(r.stdout).toContain("[dry-run] npm install -g @prestyj/cli@latest");
        expect(r.stdout).toContain("[dry-run] ezcoder node init --name box --labels gpu");
        expect(r.stdout).toContain("[dry-run] ezcoder node install");
      });

      it(`${name} rejects unknown options`, () => {
        const r = spawnSync("bash", [file, "--bogus"], { encoding: "utf8" });
        expect(r.status).toBe(2);
        expect(r.stderr).toContain("unknown option: --bogus");
      });
    }
  },
);
