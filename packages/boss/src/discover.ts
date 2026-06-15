// Project discovery moved to @prestyj/cli (one home — also used by the
// ezcoder-app sidecar). Re-exported here so existing `./discover.js` imports keep
// resolving unchanged.
export { discoverProjects, type DiscoveredProject, type ProjectSource } from "@prestyj/cli";
