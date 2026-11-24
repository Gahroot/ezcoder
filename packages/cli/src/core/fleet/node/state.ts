// Durable node state (<dataDir>/state.json): jobs and services survive a node
// restart so they can be re-adopted. Single writer (the node process), atomic
// replace on every save.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DockerSpec, JobStatus, PortSpec, ServiceStatus } from "../protocol.js";
import { writeFileAtomic } from "./config.js";

export interface JobRecord {
  status: JobStatus;
  timeoutMinutes: number;
  /** Repository root and working folder (root + subdir). */
  root?: string;
  cwd?: string;
  subdir?: string;
  docker?: DockerSpec;
  artifactGlobs?: string[];
  /** Pid of the detached wrapper shell (its own process group). */
  wrapperPid?: number;
  cancelRequested?: boolean;
}

export interface ServiceRecord {
  status: ServiceStatus;
  /** Host ports chosen per container port. */
  ports: Array<PortSpec & { hostPort: number }>;
  /** True when we built the image `ezf-<id>` ourselves (removed on delete). */
  builtImage?: boolean;
  image?: string;
  /** Whether a workspace is mounted at /w. */
  workspace?: boolean;
  idleStopMinutes?: number;
  lastActiveAt?: string;
}

interface StateFile {
  version: 1;
  /** Machine boot time (ms); pids are meaningless after a reboot. */
  bootTime: number;
  jobs: JobRecord[];
  services: ServiceRecord[];
}

export function currentBootTime(): number {
  return Date.now() - os.uptime() * 1000;
}

export class StateStore {
  readonly file: string;
  data: StateFile;
  /** Boot time recorded by the previous node process (0 when unknown). */
  readonly previousBootTime: number;

  constructor(readonly dataDir: string) {
    this.file = path.join(dataDir, "state.json");
    let loaded: Partial<StateFile> = {};
    try {
      loaded = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<StateFile>;
    } catch {
      // fresh node
    }
    this.previousBootTime = loaded.bootTime ?? 0;
    this.data = {
      version: 1,
      bootTime: currentBootTime(),
      jobs: Array.isArray(loaded.jobs) ? loaded.jobs : [],
      services: Array.isArray(loaded.services) ? loaded.services : [],
    };
  }

  /** True when the machine rebooted since the state was written (pids invalid). */
  rebooted(): boolean {
    return !this.previousBootTime || Math.abs(this.previousBootTime - this.data.bootTime) > 120_000;
  }

  save(): void {
    writeFileAtomic(this.file, JSON.stringify(this.data, null, 2), 0o600);
  }
}
