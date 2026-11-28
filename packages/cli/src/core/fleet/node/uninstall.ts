// S6: `ezcoder node uninstall [--purge]`. Stops and removes the run-at-login
// service written by `ezcoder node install`; with --purge also deletes the
// node's data folder and its deploy secrets in the keychain.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NodePlatform } from "../protocol.js";
import { NODE_CONFIG_FILE } from "./config.js";
import { defaultExec, type NodeExec } from "./exec.js";
import { defaultSecretStore, NodeSecrets, type SecretStore } from "./secrets.js";

export const LAUNCHD_LABEL = "dev.ezcoder.node";
export const SYSTEMD_UNIT = "ezcoder-node";

export interface LoginService {
  kind: "launchd" | "systemd";
  file: string;
}

/** Where `ezcoder node install` writes the login service on this platform. */
export function loginServiceFile(
  platform: NodePlatform,
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): LoginService | undefined {
  if (platform === "macos") {
    return {
      kind: "launchd",
      file: path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
    };
  }
  if (platform === "windows") return undefined;
  const config = env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  return { kind: "systemd", file: path.join(config, "systemd", "user", `${SYSTEMD_UNIT}.service`) };
}

export interface UninstallOptions {
  dataDir: string;
  purge?: boolean;
  platform: NodePlatform;
  exec?: NodeExec;
  home?: string;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  secretStore?: SecretStore;
}

export interface UninstallResult {
  removed: string[];
  notes: string[];
}

/** True when `dir` holds node files (so --purge never deletes some other folder). */
function looksLikeNodeDir(dir: string): boolean {
  return ["node.json", "state.json", "secret-names.json"].some((f) =>
    fs.existsSync(path.join(dir, f)),
  );
}

export async function uninstallNode(o: UninstallOptions): Promise<UninstallResult> {
  const exec = o.exec ?? defaultExec;
  const result: UninstallResult = { removed: [], notes: [] };
  const svc = loginServiceFile(o.platform, o.home, o.env);

  if (svc && fs.existsSync(svc.file)) {
    if (svc.kind === "launchd") {
      const uid = o.uid ?? process.getuid?.() ?? 0;
      await exec("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`], { timeoutMs: 30_000 });
      fs.rmSync(svc.file, { force: true });
    } else {
      await exec("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT], {
        timeoutMs: 30_000,
      });
      fs.rmSync(svc.file, { force: true });
      await exec("systemctl", ["--user", "daemon-reload"], { timeoutMs: 30_000 });
    }
    result.removed.push(`login service ${svc.file} (stopped and disabled)`);
  } else {
    result.notes.push("no login service was installed");
  }
  if (o.platform === "wsl2") {
    result.notes.push(
      "if you saved ezcoder-node.vbs in your Windows Startup folder (Win+R, shell:startup), delete it there",
    );
  }

  if (!o.purge) {
    if (fs.existsSync(o.dataDir)) {
      result.notes.push(
        `kept the data folder ${o.dataDir}; \`ezcoder node uninstall --purge\` deletes it`,
      );
    }
    return result;
  }
  if (!fs.existsSync(o.dataDir)) {
    result.notes.push(`no data folder at ${o.dataDir}`);
    return result;
  }
  if (!looksLikeNodeDir(o.dataDir)) {
    throw new Error(
      `${o.dataDir} has no ${NODE_CONFIG_FILE} or state.json, so it does not look like a node data folder; nothing was deleted`,
    );
  }
  const secrets = new NodeSecrets(o.dataDir, o.secretStore ?? defaultSecretStore(exec));
  const names = secrets.list();
  let gone = 0;
  for (const n of names) {
    try {
      if (await secrets.remove(n)) gone++;
    } catch {
      result.notes.push(`could not remove deploy secret ${n} from the ${secrets.kind}`);
    }
  }
  if (gone) result.removed.push(`${gone} deploy secret(s) from the ${secrets.kind}`);
  fs.rmSync(o.dataDir, { recursive: true, force: true });
  result.removed.push(
    `data folder ${o.dataDir} (node config and token, jobs, logs, artifacts, caches)`,
  );
  result.notes.push(
    "controllers paired with this node can't reach it any more; remove it there with `ezcoder fleet remove <name>`",
  );
  return result;
}

export function formatUninstall(r: UninstallResult): string {
  const lines: string[] = [];
  if (r.removed.length) {
    lines.push("Removed:");
    for (const x of r.removed) lines.push(`  - ${x}`);
  } else {
    lines.push("Nothing to remove.");
  }
  for (const n of r.notes) lines.push(`Note: ${n}`);
  return lines.join("\n");
}
