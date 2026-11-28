import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consumePairCode, parsePairingString, readNodeConfig } from "../core/fleet/node/config.js";
import { resolveServeConfig, runNode } from "./node.js";

// Never ask the real Tailscale: `node init` and `serve` see "not running".
vi.mock("../core/fleet/node/config.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  detectTailscale: async () => ({ running: false }),
}));

function nodeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ezf-cli-node-"));
  fs.writeFileSync(
    path.join(dir, "node.json"),
    JSON.stringify({
      name: "box",
      token: "old-token",
      port: 1, // nothing listens here: commands fall back to the config file
      bind: "127.0.0.1",
      advertiseHost: "box.ts.net",
      labels: [],
      slots: 2,
    }),
  );
  return dir;
}

async function run(...argv: string[]): Promise<string> {
  let text = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    text += String(s);
    return true;
  });
  try {
    await runNode(argv);
  } finally {
    spy.mockRestore();
  }
  return text;
}

afterEach(() => vi.restoreAllMocks());

describe("ezcoder node commands", () => {
  it("lists every command in help and rejects unknown ones", async () => {
    const help = await run("help");
    for (const c of ["doctor", "rotate-token", "uninstall", "update", "config", "pair [--code]"]) {
      expect(help).toContain(c);
    }
    expect(help).not.toMatch(/experimental/i);
    await expect(runNode(["frobnicate"])).rejects.toThrow(/unknown node command: frobnicate/);
  });

  it("config --slots writes any N >= 1 and refuses 0", async () => {
    const dir = nodeDir();
    const text = await run("--data-dir", dir, "config", "--slots", "64", "--gc-days", "3");
    expect(text).toMatch(/slots +64/);
    expect(text).toContain("without a restart");
    expect(readNodeConfig(dir)).toMatchObject({ slots: 64, gcDays: 3 });
    await expect(runNode(["--data-dir", dir, "config", "--slots", "0"])).rejects.toThrow(
      /--slots must be a positive integer/,
    );
  });

  it("pair prints the string; pair --code prints a live code and a QR", async () => {
    const dir = nodeDir();
    expect((await run("--data-dir", dir, "pair")).trim()).toBe(
      "ezfleet://box@box.ts.net:1#old-token",
    );
    const text = await run("--data-dir", dir, "pair", "--code");
    const code = /Pairing code: ([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(text)?.[1];
    expect(code).toBeTruthy();
    expect(text).toMatch(/[▀▄█]/);
    expect(consumePairCode(dir, code!)).toBe(true);
  });

  it("rotate-token replaces the token and prints the new pairing string", async () => {
    const dir = nodeDir();
    const text = await run("--data-dir", dir, "rotate-token");
    const token = readNodeConfig(dir)!.token;
    expect(token).not.toBe("old-token");
    const pairing = /ezcoder fleet add '([^']+)'/.exec(text)?.[1] ?? "";
    expect(parsePairingString(pairing)?.token).toBe(token);
  });

  it("commands that need a node say how to make one", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "ezf-cli-empty-"));
    await expect(runNode(["--data-dir", empty, "doctor"])).rejects.toThrow(
      /run `ezcoder node init` first/,
    );
    await expect(runNode(["--data-dir", empty, "serve", "--tls-cert", "/x"])).rejects.toThrow(
      /run `ezcoder node init` first/,
    );
  });

  it("init --docker-only saves it; serve --docker-only turns it on for the run (X5)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ezf-cli-init-"));
    const text = await run(
      "--data-dir",
      dir,
      "init",
      "--name",
      "box",
      "--host",
      "box.ts.net",
      "--docker-only",
    );
    expect(text).toContain("docker-only: host-shell jobs and remote agents are refused");
    expect(readNodeConfig(dir)?.dockerOnly).toBe(true);
    expect(await run("help")).toContain("--docker-only");

    const plain = readNodeConfig(nodeDir())!;
    expect(plain.dockerOnly).toBeUndefined();
    const served = await resolveServeConfig(["--docker-only"], { ...plain });
    expect(served.dockerOnly).toBe(true);
  });

  it("serve refuses non-Tailscale and every-interface binds without --insecure-bind (X4)", async () => {
    const cfg = () => ({ ...readNodeConfig(nodeDir())!, bind: "" });
    await expect(resolveServeConfig(["--bind", "192.168.1.20"], cfg())).rejects.toThrow(
      /refusing to listen on 192\.168\.1\.20: it is not a Tailscale or loopback address/,
    );
    await expect(resolveServeConfig(["--bind", "0.0.0.0"], cfg())).rejects.toThrow(
      /refusing to listen on every interface \(0\.0\.0\.0\)/,
    );
    // Without Tailscale and without --bind there is nothing private to listen on.
    await expect(resolveServeConfig([], cfg())).rejects.toThrow(/Tailscale is not running/);
    // Allowed: an explicit opt-in, loopback, and a Tailscale address.
    expect(
      (await resolveServeConfig(["--bind", "192.168.1.20", "--insecure-bind"], cfg())).bind,
    ).toBe("192.168.1.20");
    expect((await resolveServeConfig(["--bind", "127.0.0.1"], cfg())).bind).toBe("127.0.0.1");
    expect((await resolveServeConfig(["--bind", "100.64.0.7"], cfg())).bind).toBe("100.64.0.7");
  });
});
