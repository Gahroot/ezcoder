// X10: optional TLS for nodes that can't use Tailscale. With tlsCert/tlsKey in
// the config the node serves https; the controller pins the certificate's
// SHA-256 (sent in the ezfleets:// pairing string and in hello.tlsFingerprint).
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { certFingerprint } from "./config.js";
import type { NodeConfig } from "./context.js";

export interface NodeListener {
  server: http.Server | https.Server;
  scheme: "http" | "https";
  /** Cert SHA-256 (64 hex), only with TLS. */
  fingerprint?: string;
}

/** Read and check a cert/key pair; throws a plain message naming the bad file. */
export function loadTlsFiles(
  certFile: string,
  keyFile: string,
): {
  cert: string;
  key: string;
  fingerprint: string;
} {
  const read = (f: string, what: string) => {
    try {
      return fs.readFileSync(f, "utf8");
    } catch (e) {
      throw new Error(`can't read the TLS ${what} ${f}: ${(e as Error).message}`, { cause: e });
    }
  };
  const cert = read(certFile, "certificate");
  const key = read(keyFile, "key");
  let fingerprint: string;
  try {
    fingerprint = certFingerprint(cert);
  } catch (e) {
    throw new Error(`${certFile} is not a PEM certificate`, { cause: e });
  }
  return { cert, key, fingerprint };
}

/** http or https server for the node, depending on the config. */
export function createNodeListener(
  config: Pick<NodeConfig, "tlsCert" | "tlsKey">,
  handler: http.RequestListener,
): NodeListener {
  if (!config.tlsCert && !config.tlsKey) {
    return { server: http.createServer(handler), scheme: "http" };
  }
  if (!config.tlsCert || !config.tlsKey) {
    throw new Error("TLS needs both a certificate and a key: pass --tls-cert FILE --tls-key FILE");
  }
  const { cert, key, fingerprint } = loadTlsFiles(config.tlsCert, config.tlsKey);
  let server: https.Server;
  try {
    server = https.createServer({ cert, key, minVersion: "TLSv1.2" }, handler);
  } catch (e) {
    throw new Error(`the TLS certificate and key don't work together: ${(e as Error).message}`, {
      cause: e,
    });
  }
  return { server, scheme: "https", fingerprint };
}
