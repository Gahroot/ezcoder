import { getGitDirtyFileCount } from "../utils/git.js";
import { getGitHubOpenCounts, type GitHubOpenCounts } from "../utils/github.js";
import { startGitHubCIPoll, type GitHubCI } from "../utils/github-ci.js";
import { createSharedPolls, startIntervalPoll, type SharedPolls } from "../utils/shared-poll.js";

/**
 * Daemon-wide repo pollers, shared by every window on the same repo so
 * opening a project twice doesn't double the git/`gh` processes.
 * Keys: `dirtyFiles` and `gitHubCI` by resolved cwd (a worktree has its own
 * files and HEAD); `gitHubCounts` by `owner/repo` (counts are repo-wide).
 */
export interface RepoPolls {
  readonly dirtyFiles: SharedPolls<number>;
  readonly gitHubCounts: SharedPolls<GitHubOpenCounts>;
  readonly gitHubCI: SharedPolls<GitHubCI | null>;
}

export function createRepoPolls(): RepoPolls {
  return {
    // Files change outside the agent (editor saves, terminal commits).
    dirtyFiles: createSharedPolls((cwd, publish) =>
      startIntervalPoll({
        fetch: () => getGitDirtyFileCount(cwd),
        publish,
        firstDelayMs: 5000,
        intervalMs: 5000,
      }),
    ),
    // Issues/PRs change outside the app; network-bound, so a slow cadence well
    // under the search API's rate budget (2 calls per tick).
    gitHubCounts: createSharedPolls((slug, publish) =>
      startIntervalPoll({
        fetch: () => getGitHubOpenCounts(slug),
        publish,
        firstDelayMs: 2000,
        intervalMs: 60_000,
      }),
    ),
    gitHubCI: createSharedPolls((cwd, publish) => startGitHubCIPoll(cwd, publish)),
  };
}
