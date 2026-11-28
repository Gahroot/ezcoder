import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { NodeExec } from "./exec.js";
import { memorySecretStore } from "./secrets.js";
import { formatUninstall, loginServiceFile, uninstallNode } from "./uninstall.js";
import { tempDir } from "./__fixtures__/server.js";

function fakeExec(): NodeExec & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args].join(" "));
    return { code: 0, stdout: "", stderr: "" };
  }) as NodeExec & { calls: string[] };
  fn.calls = calls;
  return fn;
}

function nodeDir(): string {
  const dir = path.join(tempDir(), "node");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "node.json"), "{}");
  return dir;
}

describe("node uninstall", () => {
  it("boots out the launchd agent and keeps data without --purge", async () => {
    const home = tempDir();
    const svc = loginServiceFile("macos", home)!;
    fs.mkdirSync(path.dirname(svc.file), { recursive: true });
    fs.writeFileSync(svc.file, "<plist/>");
    const exec = fakeExec();
    const dataDir = nodeDir();
    const r = await uninstallNode({ dataDir, platform: "macos", home, exec, uid: 501 });
    expect(exec.calls).toEqual(["launchctl bootout gui/501/dev.ezcoder.node"]);
    expect(fs.existsSync(svc.file)).toBe(false);
    expect(fs.existsSync(dataDir)).toBe(true);
    expect(formatUninstall(r)).toMatch(/Removed:\n {2}- login service/);
    expect(formatUninstall(r)).toContain("--purge");
  });

  it("disables the systemd unit and purges data and secrets", async () => {
    const home = tempDir();
    const env = { XDG_CONFIG_HOME: path.join(home, "cfg") };
    const svc = loginServiceFile("linux", home, env)!;
    expect(svc.file).toBe(path.join(home, "cfg", "systemd", "user", "ezcoder-node.service"));
    fs.mkdirSync(path.dirname(svc.file), { recursive: true });
    fs.writeFileSync(svc.file, "[Unit]");
    const exec = fakeExec();
    const dataDir = nodeDir();
    fs.writeFileSync(
      path.join(dataDir, "secret-names.json"),
      JSON.stringify({ names: ["NPM_TOKEN"] }),
    );
    const store = memorySecretStore({ NPM_TOKEN: "x" });
    const r = await uninstallNode({
      dataDir,
      purge: true,
      platform: "linux",
      home,
      env,
      exec,
      secretStore: store,
    });
    expect(exec.calls).toEqual([
      "systemctl --user disable --now ezcoder-node",
      "systemctl --user daemon-reload",
    ]);
    expect(fs.existsSync(dataDir)).toBe(false);
    expect(store.values.size).toBe(0);
    expect(r.removed.join("\n")).toMatch(/1 deploy secret/);
  });

  it("refuses to purge a folder that is not a node data folder", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "precious.txt"), "keep");
    await expect(
      uninstallNode({
        dataDir: dir,
        purge: true,
        platform: "linux",
        home: tempDir(),
        env: {},
        exec: fakeExec(),
      }),
    ).rejects.toThrow(/does not look like a node data folder; nothing was deleted/);
    expect(fs.existsSync(path.join(dir, "precious.txt"))).toBe(true);
  });

  it("says when nothing was installed", async () => {
    const r = await uninstallNode({
      dataDir: path.join(tempDir(), "none"),
      platform: "linux",
      home: tempDir(),
      env: {},
      exec: fakeExec(),
    });
    expect(formatUninstall(r)).toMatch(/Nothing to remove\.\nNote: no login service was installed/);
  });
});
