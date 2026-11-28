// X10: a node's TLS certificate is pinned by its SHA-256 fingerprint; any other
// certificate is refused before a single byte of the request (or token) is sent.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FleetClient, PinnedTlsAgent, pinnedFetch, TlsPinError } from "./client.js";
import { certFingerprint, generateSelfSignedCert } from "./node/config.js";
import { tempDir } from "./node/__fixtures__/server.js";

const hasOpenssl = spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;

describe.skipIf(!hasOpenssl)("TLS pinning (needs openssl to make test certificates)", () => {
  let server: https.Server;
  let url = "";
  let served = "";
  let other = "";
  let requests = 0;

  beforeAll(async () => {
    const a = await generateSelfSignedCert(tempDir("ezf-tls-a-"), "127.0.0.1");
    const b = await generateSelfSignedCert(tempDir("ezf-tls-b-"), "127.0.0.1");
    const cert = fs.readFileSync(a.cert, "utf8");
    served = certFingerprint(cert);
    other = certFingerprint(fs.readFileSync(b.cert, "utf8"));
    server = https.createServer({ cert, key: fs.readFileSync(a.key, "utf8") }, (_req, res) => {
      requests++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ezcoderNode: true,
          protocol: 2,
          name: "box",
          version: "1",
          platform: "linux",
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
  });

  it("talks to the node whose certificate matches the pin", async () => {
    const client = new FleetClient("box", url, "tok", { fingerprint: served });
    expect((await client.hello()).name).toBe("box");
  });

  it("refuses a different certificate and sends nothing", async () => {
    expect(other).not.toBe(served);
    const before = requests;
    const client = new FleetClient("box", url, "tok", { fingerprint: other });
    await expect(client.hello()).rejects.toThrow(
      /presented a different TLS certificate than the one it was paired with.*nothing was sent/,
    );
    await expect(pinnedFetch(new PinnedTlsAgent(other))(`${url}/v1/info`)).rejects.toSatisfy(
      (e: unknown) => (e as Error).cause instanceof TlsPinError,
    );
    expect(requests).toBe(before);
  });
});
