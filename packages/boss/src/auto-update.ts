// The update engine now lives in @prestyj/core. This module pins it to
// gg-boss's npm package + its own state file under ~/.ezcoder/boss/ so it can't
// fight with ezcoder's checker, and supplies the ezboss restart wording.
import path from "node:path";
import os from "node:os";
import { createAutoUpdater } from "@prestyj/core";

const updater = createAutoUpdater({
  packageName: "@prestyj/boss",
  stateFilePath: () => path.join(os.homedir(), ".ezcoder", "boss", "update-state.json"),
  periodicMessage: ({ currentVersion, latestVersion, updateCommand }) =>
    `Nolan just pushed a fresh update — ${currentVersion} → ${latestVersion}! Restart ezboss to grab it (or run ${updateCommand} if you can't wait).`,
});

export const checkAndAutoUpdate = updater.checkAndAutoUpdate;
export const getPendingUpdate = updater.getPendingUpdate;
export const startPeriodicUpdateCheck = updater.startPeriodicUpdateCheck;
export const stopPeriodicUpdateCheck = updater.stopPeriodicUpdateCheck;
