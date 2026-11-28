import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ServiceRequest } from "../protocol.js";
import {
  defaultSlots,
  isPrivateBind,
  isWildcardBind,
  pairingString,
  parsePairingString,
  readNodeConfig,
  readSecrets,
  setSecret,
} from "./config.js";
import { validateDockerArgs, validateDockerSpec } from "./docker.js";
import type { ExecOptions, ExecResult, NodeExec } from "./exec.js";
import { detectPlatform, parseNvidiaSmi } from "./info.js";
import { JobManager } from "./jobs.js";
import { resolveDevenvImage, ServiceManager } from "./services.js";
import { StateStore } from "./state.js";
import { tempDir, testConfig } from "./__fixtures__/server.js";

function fakeExec(reply: (cmd: string, args: string[]) => Partial<ExecResult> = () => ({})) {
  const calls: Array<{ cmd: string; args: string[]; opts?: ExecOptions }> = [];
  const exec: NodeExec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { code: 0, stdout: "", stderr: "", ...reply(cmd, args) };
  };
  return { exec, calls };
}

describe("docker validation", () => {
  it("refuses privilege escalation, host namespaces and host mounts", () => {
    for (const bad of [
      ["--privileged"],
      ["--network", "host"],
      ["--network=host"],
      ["--net", "host"],
      ["--pid=host"],
      ["--cap-add", "SYS_ADMIN"],
      ["--security-opt", "seccomp=unconfined"],
      ["-v", "/:/host"],
      ["-v", "/var/run/docker.sock:/var/run/docker.sock"],
      ["--mount", "type=bind,source=/etc,target=/x"],
      ["--name", "other"],
    ]) {
      expect(validateDockerArgs(bad), bad.join(" ")).toBeDefined();
    }
    expect(
      validateDockerArgs(["--shm-size", "2g", "-v", "models:/models", "--network", "bridge"]),
    ).toBeUndefined();
    expect(validateDockerArgs(["-v", "/data/node/cache/x:/x"], "/data/node")).toBeUndefined();
  });

  it("checks specs", () => {
    expect(validateDockerSpec({ image: "node:22" })).toBeUndefined();
    expect(validateDockerSpec({ image: "-it" })).toBeDefined();
    expect(validateDockerSpec({ dockerfile: "../Dockerfile" })).toBeDefined();
    expect(validateDockerSpec({ compose: "compose.yml" })).toMatch(/service/);
    expect(validateDockerSpec({})).toBeDefined();
  });
});

describe("job docker commands", () => {
  const dataDir = tempDir();
  const jobs = new JobManager({
    config: testConfig(dataDir),
    state: new StateStore(dataDir),
    exec: fakeExec().exec,
    slots: { acquire: () => true, release: () => {} },
  });
  const ws = { root: "/data/jobs/j1", cwd: "/data/jobs/j1/app", subdir: "app" };
  const base = { id: "j1", project: "you/repo", command: "npm test" };

  it("wraps an image run with labels, mounts, caches and gpus", () => {
    const { command, env } = jobs.buildCommand(
      {
        ...base,
        env: { FOO: "bar" },
        docker: { image: "node:22", gpu: true },
        resources: { cpus: 2, memoryGb: 4 },
      },
      ws,
      { TOKEN: "x" },
    );
    expect(command).toContain(
      "'docker' 'run' '--rm' '--name' 'ezf-j1' '--label' 'ezcoder.fleet=j1'",
    );
    expect(command).toContain("'-v' '/data/jobs/j1:/w' '-w' '/w/app'");
    expect(command).toMatch(/'-v' '[^']*cache[/\\]you_repo:\/cache'/);
    expect(command).toContain("'--gpus' 'all'");
    expect(command).toContain("'--cpus' '2' '--memory' '4096m'");
    expect(command).toContain("'-e' 'TOKEN'");
    expect(command).not.toContain("'x'"); // secret values never on argv
    expect(env).toMatchObject({
      FOO: "bar",
      TOKEN: "x",
      npm_config_cache: "/cache/npm",
      EZ_CACHE: "/cache",
    });
  });

  it("builds a Dockerfile first and uses compose projects", () => {
    const built = jobs.buildCommand(
      { ...base, docker: { dockerfile: "engine/Dockerfile" } },
      ws,
    ).command;
    expect(built).toMatch(/^'docker' 'build' '-t' 'ezf-j1'.* && 'docker' 'run'/);
    const compose = jobs.buildCommand(
      { ...base, docker: { compose: "compose.yml", service: "app" } },
      ws,
    );
    expect(compose.command).toContain("COMPOSE_PROJECT_NAME=ezf-j1");
    expect(compose.command).toContain("'run' '--rm'");
    expect(compose.command).toContain("'down' '-v' '--remove-orphans'");
  });

  it("uses host cache env without docker", () => {
    const { command, env } = jobs.buildCommand(base, ws);
    expect(command).toBe("npm test");
    expect(env.EZ_CACHE).toContain(path.join("cache", "you_repo"));
  });
});

describe("services (mocked docker)", () => {
  function manager(reply?: Parameters<typeof fakeExec>[0], wsDir?: string) {
    const dataDir = tempDir();
    const fe = fakeExec(reply);
    const svc = new ServiceManager({
      config: testConfig(dataDir),
      state: new StateStore(dataDir),
      exec: fe.exec,
      freePort: async () => 41234,
      prepare: async () => {
        const root = wsDir ?? fs.mkdtempSync(path.join(dataDir, "ws-"));
        return { root, cwd: root, subdir: "" };
      },
    });
    return { svc, ...fe };
  }

  it("runs a detached, labelled container published on the bind address", async () => {
    const { svc, calls } = manager();
    const req: ServiceRequest = {
      id: "llm",
      kind: "inference",
      docker: { image: "ollama/ollama", gpu: true },
      ports: [{ container: 11434, name: "openai" }],
      persist: "ollama",
    };
    expect((await svc.submit(req)).status).toBe(201);
    await svc.settled("llm");
    const run = calls.find((c) => c.args[0] === "run")!;
    expect(run.args).toEqual(
      expect.arrayContaining([
        "-d",
        "--restart",
        "unless-stopped",
        "ezcoder.fleet.service=llm",
        "ezf-vol-ollama:/persist",
      ]),
    );
    expect(run.args.join(" ")).toContain("-p 127.0.0.1:41234:11434");
    expect(run.args.join(" ")).toContain("--gpus all");
    expect(run.args.at(-1)).toBe("ollama/ollama");
    const st = (await svc.get("llm"))!;
    expect(st.endpoints).toEqual([{ name: "openai", url: "http://my-pc.example.ts.net:41234" }]);
  });

  it("reports a crash-looping (restarting) container as an error, not running", async () => {
    const { svc } = manager((_c, args) =>
      args[0] === "ps" ? { stdout: "web\trestarting\n" } : {},
    );
    const req: ServiceRequest = {
      id: "web",
      kind: "custom",
      docker: { image: "alpine:3" },
      command: "exit 1",
      ports: [{ container: 8080, name: "http" }],
    };
    expect((await svc.submit(req)).status).toBe(201);
    await svc.settled("web");
    await svc.refresh();
    const st = (await svc.get("web"))!;
    expect(st.state).toBe("error");
    expect(st.summary).toMatch(/restarting/);
  });

  it("devenv picks the devcontainer image, sleeps forever and execs in /w", async () => {
    const ws = tempDir("ezf-ws-");
    fs.mkdirSync(path.join(ws, ".devcontainer"));
    fs.writeFileSync(
      path.join(ws, ".devcontainer", "devcontainer.json"),
      '{\n // comment\n "image": "mcr.microsoft.com/devcontainers/base:ubuntu",\n}',
    );
    const { svc, calls } = manager(
      (_c, args) =>
        args[0] === "ps"
          ? { stdout: "dev\trunning\n" }
          : args[0] === "exec"
            ? { stdout: "hi\n", code: 0 }
            : {},
      ws,
    );
    await svc.submit({ id: "dev", kind: "devenv", docker: {}, ports: [] });
    await svc.settled("dev");
    const run = calls.find((c) => c.args[0] === "run")!;
    expect(run.args.join(" ")).toContain(
      "--entrypoint sleep mcr.microsoft.com/devcontainers/base:ubuntu infinity",
    );
    expect(run.args.join(" ")).toContain(`-v ${ws}:/w -w /w`);
    const r = await svc.execIn("dev", { command: "echo hi" });
    expect(r.body).toEqual({ exitCode: 0, output: "hi\n" });
    expect(calls.at(-1)!.args).toEqual(["exec", "-w", "/w", "ezf-dev", "sh", "-lc", "echo hi"]);
    await svc.remove("dev");
    expect(calls.some((c) => c.args.join(" ") === "rm -f ezf-dev")).toBe(true);
  });

  it("refuses exec on non-dev services and reports failed runs", async () => {
    const { svc } = manager((_c, args) =>
      args[0] === "run" ? { code: 125, stderr: "pull denied" } : {},
    );
    await svc.submit({ id: "b", kind: "browser", docker: { image: "x/y" }, ports: [] });
    await svc.settled("b");
    expect((await svc.get("b"))!.state).toBe("error");
    expect((await svc.execIn("b", { command: "ls" })).status).toBe(400);
    expect(
      (
        await svc.submit({
          id: "c",
          kind: "custom",
          docker: { image: "x", args: ["--privileged"] },
          ports: [],
        })
      ).status,
    ).toBe(400);
  });

  it("falls back to a language image for devenv", () => {
    const ws = tempDir("ezf-ws-");
    fs.writeFileSync(path.join(ws, "package.json"), "{}");
    expect(resolveDevenvImage(ws)).toEqual({ image: "node:22" });
    fs.writeFileSync(path.join(ws, "Dockerfile"), "FROM x");
    expect(resolveDevenvImage(ws)).toMatchObject({ dockerfile: path.join(ws, "Dockerfile") });
  });
});

describe("config and info helpers", () => {
  it("round-trips pairing strings and computes default slots", () => {
    const s = pairingString({
      name: "gpu-box",
      advertiseHost: "gpu-box.example.ts.net",
      port: 7377,
      token: "t0k",
    });
    expect(s).toBe("ezfleet://gpu-box@gpu-box.example.ts.net:7377#t0k");
    expect(parsePairingString(s)).toEqual({
      name: "gpu-box",
      host: "gpu-box.example.ts.net",
      port: 7377,
      token: "t0k",
    });
    expect(defaultSlots(16, 32)).toBe(8);
    expect(defaultSlots(4, 64)).toBe(2);
    expect(defaultSlots(2, 64)).toBe(1);
  });

  it("detects WSL2 and parses nvidia-smi", () => {
    expect(detectPlatform("linux", () => "Linux version 5.15 (microsoft-standard-WSL2)")).toBe(
      "wsl2",
    );
    expect(detectPlatform("linux", () => "Linux version 6.8 generic")).toBe("linux");
    expect(detectPlatform("darwin")).toBe("macos");
    expect(parseNvidiaSmi("NVIDIA GeForce RTX 4090, 24564, 1024, 7\n")).toEqual([
      {
        name: "NVIDIA GeForce RTX 4090",
        memoryGb: 24,
        memoryUsedGb: 1,
        utilizationPct: 7,
        vendor: "nvidia",
      },
    ]);
  });
});

describe("security regressions", () => {
  it("refuses bypass forms of docker args", () => {
    const root = tempDir();
    for (const bad of [
      ["-v/:/host"],
      ["-v=/:/host"],
      ["-itv/:/host"],
      ["-it", "-v", "/etc:/x"],
      ["--network=HOST"],
      ["--ipc", "host"],
      ["--userns=host"],
      ["--cap-add=ALL"],
      ["--security-opt", "label=disable"],
      ["--security-opt=apparmor=unconfined"],
      ["--device", "/dev/hda"],
      ["--device=/dev/mapper/root"],
      ["--device-cgroup-rule", "a *:* rwm"],
      ["--mount", "TYPE=BIND,SOURCE=/,target=/h"],
      ["--mount", '"type=bind","source=/etc",target=/h'],
      [
        "--mount",
        "type=volume,src=v,dst=/h,volume-opt=type=none,volume-opt=o=bind,volume-opt=device=/",
      ],
      ["-v", "C:\\:/host"],
      // The node's own token/secrets folder, even though it is under dataDir.
      ["-v", `${root}:/node`],
      ["-v", `${root}/secrets.json:/s`],
    ]) {
      expect(validateDockerArgs(bad, root), bad.join(" ")).toBeDefined();
    }
    expect(validateDockerArgs(["--device", "/dev/dri", "-e", "X", "-it"])).toBeUndefined();
    expect(validateDockerArgs(["-e", "-v/:/x"])).toBeUndefined(); // value of -e, not a mount
  });

  it.skipIf(process.platform === "win32")(
    "follows symlinks under dataDir before allowing a mount",
    () => {
      const root = tempDir();
      fs.mkdirSync(path.join(root, "jobs", "j1"), { recursive: true });
      fs.symlinkSync("/", path.join(root, "jobs", "j1", "up"));
      expect(validateDockerArgs(["-v", `${root}/jobs/j1/up:/h`], root)).toMatch(/not allowed/);
      expect(validateDockerArgs(["-v", `${root}/jobs/j1:/w2`], root)).toBeUndefined();
    },
  );

  it("refuses devcontainer images that are flags and Dockerfiles outside the workspace", () => {
    const ws = tempDir();
    fs.mkdirSync(path.join(ws, ".devcontainer"));
    const dc = path.join(ws, ".devcontainer", "devcontainer.json");
    fs.writeFileSync(dc, JSON.stringify({ image: "--privileged" }));
    expect(() => resolveDevenvImage(ws)).toThrow(/invalid devcontainer image/);
    fs.writeFileSync(
      dc,
      JSON.stringify({ build: { dockerfile: "/etc/Dockerfile", context: "/" } }),
    );
    expect(() => resolveDevenvImage(ws)).toThrow(/inside the workspace/);
  });

  it("recognises every-interface bind addresses", () => {
    for (const b of [
      "0.0.0.0",
      "0",
      "::",
      "[::]",
      "::0",
      "0:0:0:0:0:0:0:0",
      "::ffff:0.0.0.0",
      "*",
    ]) {
      expect(isWildcardBind(b), b).toBe(true);
    }
    for (const b of ["100.64.0.1", "127.0.0.1", "fd7a:115c:a1e0::1", "my-pc"]) {
      expect(isWildcardBind(b), b).toBe(false);
    }
  });
});

describe("hardening regressions", () => {
  it("never lets a flag hide as another flag's value, and refuses unknown flags", () => {
    const root = tempDir();
    for (const bad of [
      ["--label", "-l", "--privileged"],
      ["--label", "-l", "--volume=/:/host"],
      ["--hostname", "-e", "--pid=host"],
      ["--env-file", "/etc/passwd"],
      ["--label-file=/etc/passwd"],
      ["--cidfile", "/tmp/x"],
      ["-p", "0.0.0.0:80:80"],
      ["-p", "8080:80"],
      ["--security-opt", "seccomp=/w/profile.json"],
      ["--label", "ezcoder.fleet=other"],
      ["--runtime", "sysbox"],
      ["-d"],
      ["ubuntu"],
      ["--label"],
      // Other people's work and the node's private files, even under dataDir.
      ["-v", `${root}/agents/a1:/a`],
      ["-v", `${root}/artifacts:/a`],
      ["-v", `${root}/Node.json:/n`],
      ["-v", `${root}/SECRETS.JSON:/s`],
    ]) {
      expect(validateDockerArgs(bad, root), bad.join(" ")).toBeDefined();
    }
    for (const ok of [
      ["--label", "team=a", "-e", "FOO=bar", "--shm-size=2g"],
      ["-p", "127.0.0.1:8080:80", "--init", "--tmpfs", "/tmp"],
      ["--security-opt", "no-new-privileges", "--cap-drop", "ALL"],
      ["-v", `${root}/cache/x:/c`],
    ]) {
      expect(validateDockerArgs(ok, root), ok.join(" ")).toBeUndefined();
    }
  });

  it("only treats loopback and Tailscale addresses as private", () => {
    for (const b of ["127.0.0.1", "100.64.0.1", "100.127.255.254", "fd7a:115c:a1e0::1", "::1"]) {
      expect(isPrivateBind(b), b).toBe(true);
    }
    for (const b of ["192.168.1.20", "10.0.0.5", "100.128.0.1", "100.63.0.1", "8.8.8.8", "my-pc"]) {
      expect(isPrivateBind(b), b).toBe(false);
    }
  });

  it("refuses a damaged secrets or node file instead of treating it as empty", () => {
    const dir = tempDir();
    setSecret(dir, "A", "1");
    fs.writeFileSync(path.join(dir, "secrets.json"), '{"A":"1"');
    expect(() => readSecrets(dir)).toThrow(/damaged/);
    expect(() => setSecret(dir, "B", "2")).toThrow(/damaged/);
    expect(fs.readFileSync(path.join(dir, "secrets.json"), "utf8")).toBe('{"A":"1"');
    fs.writeFileSync(path.join(dir, "node.json"), "{oops");
    expect(() => readNodeConfig(dir)).toThrow(/damaged/);
    expect(readNodeConfig(tempDir())).toBeUndefined();
  });
});
