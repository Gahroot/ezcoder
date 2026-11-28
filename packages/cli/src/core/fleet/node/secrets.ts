// X8: node-local deploy secrets live in the OS keychain (macOS `security`
// generic passwords, Linux Secret Service via `secret-tool`), so a host-shell
// job can't simply read them from a file under the data folder. Only the
// secret *names* are kept on disk (<dataDir>/secret-names.json). With no
// keychain, setting a secret is refused: there is no plaintext fallback.
// An old plaintext <dataDir>/secrets.json is moved into the keychain, then deleted.
import fs from "node:fs";
import path from "node:path";
import { isValidSecretName, readSecrets, SECRETS_FILE, writeFileAtomic } from "./config.js";
import { defaultExec, type NodeExec } from "./exec.js";

export const SECRET_SERVICE = "ezcoder-node";
export const SECRET_NAMES_FILE = "secret-names.json";

/** A keychain backend. Injectable so tests never touch the real keychain. */
export interface SecretStore {
  /** Human name, e.g. "macOS keychain". */
  readonly kind: string;
  available(): Promise<boolean>;
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export const NO_KEYCHAIN_MESSAGE =
  "no OS keychain is available on this machine, so deploy secrets can't be stored safely. " +
  "On Linux install the Secret Service tools and a keyring (e.g. `sudo apt install libsecret-tools gnome-keyring`); " +
  "on macOS run this from a logged-in user session. Secrets are never written to a plain file.";

export function macKeychainStore(exec: NodeExec = defaultExec): SecretStore {
  return {
    kind: "macOS keychain",
    async available() {
      return (await exec("security", ["default-keychain"], { timeoutMs: 10_000 })).code === 0;
    },
    async get(name) {
      const r = await exec(
        "security",
        ["find-generic-password", "-s", SECRET_SERVICE, "-a", name, "-w"],
        { timeoutMs: 15_000 },
      );
      return r.code === 0 ? r.stdout.replace(/\n$/, "") : undefined;
    },
    async set(name, value) {
      const r = await exec(
        "security",
        ["add-generic-password", "-U", "-s", SECRET_SERVICE, "-a", name, "-w", value],
        { timeoutMs: 15_000 },
      );
      if (r.code !== 0) throw new Error(`keychain refused the secret: ${r.stderr.trim()}`);
    },
    async delete(name) {
      await exec("security", ["delete-generic-password", "-s", SECRET_SERVICE, "-a", name], {
        timeoutMs: 15_000,
      });
    },
  };
}

export function secretServiceStore(exec: NodeExec = defaultExec): SecretStore {
  const attrs = (name: string) => ["service", SECRET_SERVICE, "name", name];
  return {
    kind: "Secret Service keyring",
    async available() {
      const r = await exec("secret-tool", ["lookup", ...attrs("__ezcoder_probe__")], {
        timeoutMs: 10_000,
      });
      if (r.code === 127) return false;
      return !/d-?bus|secret ?service|org\.freedesktop|cannot|couldn't|not provided/i.test(
        r.stderr,
      );
    },
    async get(name) {
      const r = await exec("secret-tool", ["lookup", ...attrs(name)], { timeoutMs: 15_000 });
      return r.code === 0 ? r.stdout : undefined;
    },
    async set(name, value) {
      // The value goes over stdin, never argv.
      const r = await exec(
        "secret-tool",
        ["store", `--label=ezcoder node secret ${name}`, ...attrs(name)],
        { timeoutMs: 15_000, input: value },
      );
      if (r.code !== 0) throw new Error(`keyring refused the secret: ${r.stderr.trim()}`);
    },
    async delete(name) {
      await exec("secret-tool", ["clear", ...attrs(name)], { timeoutMs: 15_000 });
    },
  };
}

/** No keychain at all (native Windows, or tests). */
export const unavailableStore: SecretStore = {
  kind: "none",
  available: async () => false,
  get: async () => undefined,
  set: async () => {
    throw new Error(NO_KEYCHAIN_MESSAGE);
  },
  delete: async () => {},
};

export function defaultSecretStore(
  exec: NodeExec = defaultExec,
  platform: NodeJS.Platform = process.platform,
): SecretStore {
  if (platform === "darwin") return macKeychainStore(exec);
  if (platform === "linux" || platform === "freebsd") return secretServiceStore(exec);
  return unavailableStore;
}

/** In-memory store for tests. */
export function memorySecretStore(initial: Record<string, string> = {}): SecretStore & {
  values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial));
  return {
    kind: "test keychain",
    values,
    available: async () => true,
    get: async (n) => values.get(n),
    set: async (n, v) => void values.set(n, v),
    delete: async (n) => void values.delete(n),
  };
}

export class NodeSecrets {
  constructor(
    private readonly dataDir: string,
    private readonly store: SecretStore = defaultSecretStore(),
  ) {}

  get kind(): string {
    return this.store.kind;
  }

  available(): Promise<boolean> {
    return this.store.available();
  }

  private namesFile(): string {
    return path.join(this.dataDir, SECRET_NAMES_FILE);
  }

  list(): string[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.namesFile(), "utf8")) as { names?: unknown };
      return Array.isArray(raw.names)
        ? raw.names.filter((n): n is string => typeof n === "string").sort()
        : [];
    } catch {
      return [];
    }
  }

  private writeNames(names: string[]): void {
    writeFileAtomic(
      this.namesFile(),
      JSON.stringify({ names: [...new Set(names)].sort() }, null, 2) + "\n",
    );
  }

  async set(name: string, value: string): Promise<void> {
    if (!isValidSecretName(name)) throw new Error(`invalid secret name: ${name}`);
    if (!(await this.store.available())) throw new Error(NO_KEYCHAIN_MESSAGE);
    await this.store.set(name, value);
    this.writeNames([...this.list(), name]);
  }

  async remove(name: string): Promise<boolean> {
    if (!this.list().includes(name)) return false;
    await this.store.delete(name);
    this.writeNames(this.list().filter((n) => n !== name));
    return true;
  }

  /** Values for `names`; missing ones are absent from the result. */
  async read(names: string[]): Promise<Record<string, string>> {
    const known = new Set(this.list());
    const out: Record<string, string> = {};
    for (const n of names) {
      if (!known.has(n)) continue;
      const v = await this.store.get(n);
      if (v !== undefined) out[n] = v;
    }
    return out;
  }

  /** True when an old plaintext secrets file is still waiting to be migrated. */
  hasLegacyFile(): boolean {
    return fs.existsSync(path.join(this.dataDir, SECRETS_FILE));
  }

  /**
   * Move <dataDir>/secrets.json into the keychain and delete it. Returns a
   * plain message describing what happened, or undefined when there was nothing to do.
   */
  async migrateLegacy(): Promise<string | undefined> {
    const file = path.join(this.dataDir, SECRETS_FILE);
    if (!fs.existsSync(file)) return undefined;
    if (!(await this.store.available())) {
      return (
        `${file} holds deploy secrets in plain text and there is no keychain to move them into; ` +
        `jobs can't use them until there is. ${NO_KEYCHAIN_MESSAGE}`
      );
    }
    const legacy = readSecrets(this.dataDir);
    const moved: string[] = [];
    for (const [name, value] of Object.entries(legacy)) {
      if (!isValidSecretName(name)) continue;
      await this.store.set(name, value);
      if ((await this.store.get(name)) !== value) {
        throw new Error(
          `could not verify secret ${name} in the ${this.store.kind}; ${file} was left in place`,
        );
      }
      moved.push(name);
    }
    this.writeNames([...this.list(), ...moved]);
    fs.rmSync(file, { force: true });
    return `moved ${moved.length} deploy secret(s) (${moved.join(", ") || "none"}) from ${file} into the ${this.store.kind} and deleted the file`;
  }
}
