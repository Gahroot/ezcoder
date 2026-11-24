import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectFleetDefaults, loadFleetConfig } from "./project-config.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ezf-cfg-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
  fs.writeFileSync(path.join(tmp, rel), text);
};

describe("fleet project config", () => {
  it("detects build, e2e and dev from a node project", () => {
    write(
      "package.json",
      JSON.stringify({
        scripts: { build: "tsc" },
        devDependencies: { "@playwright/test": "^1.50.1" },
      }),
    );
    write("pnpm-lock.yaml", "");
    write("playwright.config.ts", "");
    write(
      ".devcontainer/devcontainer.json",
      '{ // comment\n "image": "mcr.microsoft.com/devcontainers/typescript-node", }',
    );
    const d = detectFleetDefaults(tmp);
    expect(d.jobs.build).toMatchObject({ kind: "build", docker: { image: "node:22" } });
    expect(d.jobs.build!.command).toContain("pnpm run build");
    expect(d.jobs.e2e).toMatchObject({
      kind: "browser",
      docker: { image: "mcr.microsoft.com/playwright:v1.50.1-noble" },
    });
    expect(d.services.dev!.docker.image).toBe("mcr.microsoft.com/devcontainers/typescript-node");
    expect(d.services.llm).toMatchObject({ kind: "inference", resources: { gpus: 1 } });
    expect(d.services.browser!.ports[0]).toMatchObject({ name: "playwright", protocol: "ws" });
  });

  it("falls back to Cargo / Makefile builds and a language dev image", () => {
    write("Cargo.toml", "");
    const d = detectFleetDefaults(tmp);
    expect(d.jobs.build!.command).toBe("cargo build --release");
    expect(d.services.dev!.docker.image).toBe("rust:1");
    expect(loadFleetConfig(tmp)).toMatchObject({ source: "auto" });
  });

  it("merges the file over defaults and validates fields", () => {
    write("package.json", JSON.stringify({ scripts: { build: "tsc" } }));
    write(
      ".ezcoder/fleet.json",
      JSON.stringify({
        jobs: {
          build: { artifacts: ["out/**"] },
          deploy: {
            kind: "deploy",
            command: "./deploy.sh",
            secrets: ["DEPLOY_TOKEN"],
            gate: false,
          },
        },
        services: { api: { kind: "devenv", ports: [{ container: 8080, name: "http" }] } },
      }),
    );
    const c = loadFleetConfig(tmp);
    if ("error" in c) throw new Error(c.error);
    expect(c.jobs.build).toMatchObject({ kind: "build", artifacts: ["out/**"] });
    expect(c.jobs.deploy).toMatchObject({ kind: "deploy", gate: false, timeoutMinutes: 30 });
    expect(c.services.api).toMatchObject({
      kind: "devenv",
      needsSource: true,
      command: "sleep infinity",
    });

    for (const bad of [
      { jobs: { x: { command: "a", kind: "nope" } } },
      { jobs: { x: {} } },
      { jobs: { x: { command: "a", secrets: ["bad name"] } } },
      { jobs: { x: { command: "a", docker: {} } } },
      { services: { s: { docker: { image: "i" }, ports: [{ container: 0, name: "p" }] } } },
    ]) {
      write(".ezcoder/fleet.json", JSON.stringify(bad));
      expect(loadFleetConfig(tmp)).toHaveProperty("error");
    }
  });
});
