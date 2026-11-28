import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pinnedFetch, pinnedTlsAgent } from "../client.js";
import type { HelloResponse } from "../protocol.js";
import { generateSelfSignedCert, parsePairingString } from "./config.js";
import { createNodeListener, loadTlsFiles } from "./tls.js";
import { startTestServer, tempDir } from "./__fixtures__/server.js";

const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;

describe("tls listener", () => {
  it("is plain http without a cert and needs both files for https", () => {
    expect(createNodeListener({}, () => {}).scheme).toBe("http");
    expect(() => createNodeListener({ tlsCert: "/x" }, () => {})).toThrow(
      /both a certificate and a key/,
    );
  });

  it("names the file it can't read or parse", () => {
    const dir = tempDir();
    const bad = path.join(dir, "bad.pem");
    fs.writeFileSync(bad, "not a cert");
    expect(() => loadTlsFiles(path.join(dir, "missing.pem"), bad)).toThrow(
      /can't read the TLS certificate/,
    );
    expect(() => loadTlsFiles(bad, bad)).toThrow(/is not a PEM certificate/);
  });

  it.skipIf(!hasOpenssl)(
    "serves https with hello.tlsFingerprint and an ezfleets pairing",
    async () => {
      const dir = tempDir();
      const { cert, key } = await generateSelfSignedCert(dir, "127.0.0.1");
      const fp = loadTlsFiles(cert, key).fingerprint;
      const s = await startTestServer(dir, { tlsCert: cert, tlsKey: key });
      try {
        expect(s.url).toMatch(/^https:/);
        const f = pinnedFetch(pinnedTlsAgent(fp));
        const hello = (await (await f(s.url + "/v1/hello")).json()) as HelloResponse;
        expect(hello.tlsFingerprint).toBe(fp);
        expect(hello.features).toContain("tls");
        const rotated = s.rotateToken();
        expect(parsePairingString(rotated.pairing)).toMatchObject({ tls: true, fingerprint: fp });
      } finally {
        await s.close();
      }
    },
  );
});
