import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "@kenkaiiii/gg-core";
import {
  LocalEndpointError,
  addCustomEndpoint,
  listAllEndpoints,
  listCustomEndpoints,
  normalizeLocalBaseUrl,
  removeCustomEndpoint,
  syncEndpointCredentials,
} from "./local-endpoint-store.js";

let home: string;
let originalHome: string | undefined;
let auth: AuthStorage;

/** The store resolves ~/.gg via os.homedir(), which honours $HOME on POSIX. */
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "gg-local-endpoints-"));
  originalHome = process.env.HOME;
  process.env.HOME = home;
  await fs.mkdir(path.join(home, ".gg"), { recursive: true });
  auth = new AuthStorage(path.join(home, ".gg", "auth.json"));
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await fs.rm(home, { recursive: true, force: true });
});

async function settings(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(home, ".gg", "gg-app.json"), "utf-8")) as Record<
    string,
    unknown
  >;
}

describe("normalizeLocalBaseUrl", () => {
  it("accepts the shapes users actually paste", () => {
    expect(normalizeLocalBaseUrl("127.0.0.1:1234")).toBe("http://127.0.0.1:1234/v1");
    expect(normalizeLocalBaseUrl("http://localhost:8000")).toBe("http://localhost:8000/v1");
    expect(normalizeLocalBaseUrl("http://localhost:8000/v1")).toBe("http://localhost:8000/v1");
    expect(normalizeLocalBaseUrl("  http://localhost:8000/v1/  ")).toBe("http://localhost:8000/v1");
    expect(normalizeLocalBaseUrl("http://box.lan:8080/v1/chat/completions")).toBe(
      "http://box.lan:8080/v1",
    );
    expect(normalizeLocalBaseUrl("http://box.lan:8080/v1/models")).toBe("http://box.lan:8080/v1");
    // A gateway on a sub-path keeps the path.
    expect(normalizeLocalBaseUrl("https://gw.example.com/openai")).toBe(
      "https://gw.example.com/openai/v1",
    );
  });

  it("rejects empty, malformed, and non-http URLs", () => {
    expect(() => normalizeLocalBaseUrl("   ")).toThrow(LocalEndpointError);
    expect(() => normalizeLocalBaseUrl("http://")).toThrow(LocalEndpointError);
    expect(() => normalizeLocalBaseUrl("ftp://host/v1")).toThrow(LocalEndpointError);
  });
});

describe("custom endpoints", () => {
  it("adds an endpoint, persists it, and writes its auth credential", async () => {
    const endpoint = await addCustomEndpoint(
      { label: "Workstation", baseUrl: "192.168.1.4:8000", apiKey: "secret" },
      auth,
    );

    expect(endpoint).toMatchObject({
      id: "custom-192-168-1-4-8000",
      label: "Workstation",
      baseUrl: "http://192.168.1.4:8000/v1",
      kind: "custom",
      custom: true,
      apiKey: "secret",
    });
    expect(await listCustomEndpoints()).toEqual([endpoint]);

    const creds = await auth.getCredentials("local:custom-192-168-1-4-8000");
    expect(creds).toMatchObject({ accessToken: "secret", baseUrl: "http://192.168.1.4:8000/v1" });
    expect(creds!.expiresAt).toBeGreaterThan(Date.now());
    expect(await auth.hasProviderAuth("local")).toBe(true);
  });

  it("defaults the label to the host and the key to a placeholder", async () => {
    await addCustomEndpoint({ baseUrl: "http://localhost:9999" }, auth);

    const stored = (await listCustomEndpoints())[0]!;
    expect(stored.label).toBe("localhost:9999");
    expect(stored.apiKey).toBeUndefined();
    expect(await auth.getCredentials("local:custom-localhost-9999")).toMatchObject({
      accessToken: "local",
    });
  });

  it("updates in place when the same host is re-added", async () => {
    await addCustomEndpoint({ baseUrl: "http://localhost:9999", apiKey: "wrong" }, auth);
    await addCustomEndpoint(
      { label: "Fixed", baseUrl: "http://localhost:9999/v1", apiKey: "right" },
      auth,
    );

    const stored = await listCustomEndpoints();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ label: "Fixed", apiKey: "right" });
    expect(await auth.getCredentials("local:custom-localhost-9999")).toMatchObject({
      accessToken: "right",
    });
  });

  it("refuses a URL already covered by a built-in endpoint", async () => {
    await expect(addCustomEndpoint({ baseUrl: "http://127.0.0.1:11434/v1" }, auth)).rejects.toThrow(
      /already probed automatically as Ollama/,
    );
  });

  it("removes an endpoint and its credential", async () => {
    await addCustomEndpoint({ baseUrl: "http://localhost:9999" }, auth);

    await removeCustomEndpoint("custom-localhost-9999", auth);

    expect(await listCustomEndpoints()).toEqual([]);
    expect(await auth.getCredentials("local:custom-localhost-9999")).toBeUndefined();
    expect(await auth.hasProviderAuth("local")).toBe(false);
  });

  it("refuses to remove a built-in or unknown endpoint", async () => {
    await expect(removeCustomEndpoint("ollama", auth)).rejects.toThrow(/built-in/);
    await expect(removeCustomEndpoint("custom-nope", auth)).rejects.toThrow(/Unknown local/);
  });

  it("preserves unrelated gg-app.json keys", async () => {
    await fs.writeFile(
      path.join(home, ".gg", "gg-app.json"),
      JSON.stringify({ projectsRoot: "/tmp/projects", autopilot: { "/a": true } }),
      "utf-8",
    );

    await addCustomEndpoint({ baseUrl: "http://localhost:9999" }, auth);

    expect(await settings()).toMatchObject({
      projectsRoot: "/tmp/projects",
      autopilot: { "/a": true },
    });
    await removeCustomEndpoint("custom-localhost-9999", auth);
    expect(await settings()).toMatchObject({ projectsRoot: "/tmp/projects" });
  });

  it("ignores a corrupt settings file instead of throwing", async () => {
    await fs.writeFile(path.join(home, ".gg", "gg-app.json"), "{not json", "utf-8");

    expect(await listCustomEndpoints()).toEqual([]);
  });

  it("lists built-in endpoints before custom ones", async () => {
    await addCustomEndpoint({ baseUrl: "http://localhost:9999" }, auth);

    expect((await listAllEndpoints()).map((e) => e.id)).toEqual([
      "ollama",
      "lmstudio",
      "llamacpp",
      "vllm",
      "custom-localhost-9999",
    ]);
  });
});

describe("syncEndpointCredentials", () => {
  it("writes a baseUrl-carrying credential for every endpoint", async () => {
    await syncEndpointCredentials(await listAllEndpoints(), auth);

    expect((await auth.listLocalEndpointIds()).sort()).toEqual([
      "llamacpp",
      "lmstudio",
      "ollama",
      "vllm",
    ]);
    expect(await auth.getCredentials("local:ollama")).toMatchObject({
      baseUrl: "http://127.0.0.1:11434/v1",
      accessToken: "local",
    });
  });
});
