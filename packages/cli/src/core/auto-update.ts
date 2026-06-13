// The update engine now lives in @prestyj/core. This module pins it to
// ezcoder's npm package + state file, keeping the "ezcoder"-branded surface and
// the same exported function names so consumers/tests are unchanged.
import path from "node:path";
import os from "node:os";
import { createAutoUpdater } from "@prestyj/core";

const updater = createAutoUpdater({
  packageName: "@prestyj/cli",
  stateFilePath: () => path.join(os.homedir(), ".ezcoder", "update-state.json"),
});

export const checkAndAutoUpdate = updater.checkAndAutoUpdate;
export const getPendingUpdate = updater.getPendingUpdate;
export const startPeriodicUpdateCheck = updater.startPeriodicUpdateCheck;
export const stopPeriodicUpdateCheck = updater.stopPeriodicUpdateCheck;
