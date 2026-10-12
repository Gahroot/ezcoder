import type http from "node:http";
import path from "node:path";
import { sessionToMarkdown, defaultExportFilename } from "../core/session-export.js";
import {
  installPlugin,
  listInstalledPlugins,
  removePlugin,
} from "../core/extensions/plugin-bundles.js";
import { discoverProjects } from "../core/project-discovery.js";
import {
  createWorktree,
  removeWorktree,
  sweepWorktrees,
  worktreeStatuses,
} from "../core/worktree.js";
import { prepareWorktree } from "../core/worktree-setup.js";
import { goalsRoot } from "../core/goals-store.js";
import { listSidecarSessions } from "../app-sidecar-sessions.js";
import { log } from "../core/logger.js";
import { readBody, json } from "./http.js";
import { parseToolDetail } from "./history.js";
import { searchProjectFiles } from "./file-search.js";
import { loadAppSettings, updateAppSettings } from "./app-settings.js";
import type { SessionRouteContext } from "./route-context.js";

export function handleWorkspaceRoutes(
  ctx: SessionRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  if (method === "GET" && url === "/plugins") {
    void listInstalledPlugins(ctx.paths.extensionsDir)
      .then((plugins) => json(res, 200, { plugins }))
      .catch((error) => {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      });
    return true;
  }

  if (method === "POST" && url === "/plugins/install") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      try {
        const bundlePath = (JSON.parse(raw) as { bundlePath?: unknown }).bundlePath;
        if (typeof bundlePath !== "string" || !path.isAbsolute(bundlePath)) {
          json(res, 400, { error: "bundlePath must be an absolute path" });
          return;
        }
        const plugin = await installPlugin(bundlePath, ctx.paths.extensionsDir);
        json(res, 200, { plugin, restartRequired: true });
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    });
    return true;
  }

  if (method === "DELETE" && url.startsWith("/plugins/")) {
    const pluginId = decodeURIComponent(url.slice("/plugins/".length));
    void removePlugin(pluginId, ctx.paths.extensionsDir)
      .then(() => json(res, 200, { removed: pluginId, restartRequired: true }))
      .catch((error) => {
        json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      });
    return true;
  }

  // Create an isolated git worktree for a project so a second window can work
  // on the same repo without fighting the first over the working tree. The
  // caller passes the project cwd; the module resolves the repo's MAIN root
  // itself, so opening this from an already-linked worktree still branches
  // off the real repo rather than nesting.
  //
  // A dirty main checkout is fine and expected here: a second window is only
  // ever opened while the first window's agent is mid-edit. The copy forks
  // from the last commit and `git worktree add` leaves the main tree
  // untouched, so nothing is stranded.
  //
  // The response waits for `prepareWorktree`, which can run a package install
  // and take minutes. That is deliberate — an agent handed a copy with no
  // node_modules reports a broken project — so the callers set a long
  // timeout. A failed install is reported IN the 200 body, not as an error:
  // the worktree exists either way and destroying it would lose the branch.
  if (method === "POST" && url === "/worktree") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let body: { cwd?: string; branch?: string; baseRef?: string; skipInstall?: boolean };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      const repoDir = body.cwd?.trim();
      if (!repoDir) {
        json(res, 400, { error: "cwd is required" });
        return;
      }
      try {
        const created = await createWorktree({
          repoDir,
          branch: body.branch?.trim() || undefined,
          baseRef: body.baseRef?.trim() || undefined,
        });
        const setup = await prepareWorktree({
          mainRoot: created.mainRoot,
          worktreePath: created.path,
          skipInstall: body.skipInstall === true,
        });
        json(res, 200, { ...created, setup });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Not-a-repo is the user's to resolve, not a bug.
        const expected = message.includes("Not a git repository");
        json(res, expected ? 409 : 500, { error: message });
      }
    });
    return true;
  }

  // Every managed copy of a repo with the state the picker needs to decide
  // what to offer: branch, unsaved files, unmerged commits, and why a copy
  // cannot be reclaimed. `busy` paths come from the caller (the app knows its
  // own windows; the daemon does not), repeated as `busy=` params.
  if (method === "GET" && (url === "/worktrees" || url.startsWith("/worktrees?"))) {
    const params = new URL(url, "http://127.0.0.1").searchParams;
    const target = params.get("cwd")?.trim() || ctx.cwd;
    void worktreeStatuses(target, params.getAll("busy"))
      .then((worktrees) => json(res, 200, { worktrees }))
      .catch((err) => {
        // Not-a-repo is the common case here, not a fault: answer "none".
        log("INFO", "app-sidecar", "worktreeStatuses failed", {
          message: err instanceof Error ? err.message : String(err),
        });
        json(res, 200, { worktrees: [] });
      });
    return true;
  }

  // Remove one copy. `force` is the user having seen what would be lost and
  // said yes anyway, so it is never defaulted on.
  //
  // `path` arrives from the client, and a request naming a path is not
  // permission to delete it: `removeWorktree` re-derives the managed root
  // from the repo itself and refuses anything outside it, or reached through
  // a symlink. The check lives there so no caller can skip it.
  if (method === "DELETE" && url === "/worktree") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let body: { cwd?: string; path?: string; force?: boolean };
      try {
        body = JSON.parse(raw) as { cwd?: string; path?: string; force?: boolean };
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      const worktreePath = body.path?.trim();
      if (!worktreePath) {
        json(res, 400, { error: "path is required" });
        return;
      }
      const release = await removeWorktree({
        repoDir: body.cwd?.trim() || ctx.cwd,
        worktreePath,
        force: body.force === true,
      });
      // removeWorktree never throws; a refusal is a 409 the UI shows as
      // written, matching the dirty-checkout gate on POST above.
      json(res, release.freed ? 200 : 409, release);
    });
    return true;
  }

  // Reclaim every copy that provably holds no work. Never forces: anything
  // with unsaved or unmerged changes comes back under `kept` with a reason
  // and waits for a human. Called on window close and on daemon startup.
  if (method === "POST" && url === "/worktrees/sweep") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let body: { cwd?: string; busyPaths?: string[] };
      try {
        body = JSON.parse(raw) as { cwd?: string; busyPaths?: string[] };
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      const busy = Array.isArray(body.busyPaths)
        ? body.busyPaths.filter((p): p is string => typeof p === "string")
        : [];
      json(res, 200, await sweepWorktrees(body.cwd?.trim() || ctx.cwd, busy));
    });
    return true;
  }

  // Dismiss a project from the picker (or restore it with hidden:false). The
  // path is kept rather than the row: sessions in scratch dirs keep
  // re-surfacing, so the user's decision has to outlive any one scan.
  if (method === "POST" && url === "/projects/hidden") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let body: { path?: string; hidden?: boolean };
      try {
        body = JSON.parse(raw) as { path?: string; hidden?: boolean };
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      const target = body.path?.trim();
      if (!target) {
        json(res, 400, { error: "path is required" });
        return;
      }
      const key = path.resolve(target);
      try {
        const current = await updateAppSettings((settings) => {
          const next = new Set((settings.hiddenProjects ?? []).map((p) => path.resolve(p)));
          if (body.hidden === false) next.delete(key);
          else next.add(key);
          settings.hiddenProjects = next.size > 0 ? Array.from(next) : undefined;
          return next;
        });
        json(res, 200, { hidden: Array.from(current) });
      } catch (err) {
        json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
    return true;
  }

  if (method === "GET" && url === "/projects") {
    // Session stores plus configured project folders, including unopened projects.
    void loadAppSettings()
      .then(({ projectsRoot, projectRoots, hiddenProjects }) =>
        discoverProjects({
          projectsRoot,
          extraRoots: projectRoots,
          hiddenPaths: hiddenProjects,
          // Goal workspaces have their own list; they are not coding projects.
          excludeRoots: [goalsRoot(ctx.paths.agentDir)],
        }),
      )
      .then((projects) => json(res, 200, { projects }))
      .catch((err) => {
        log("ERROR", "app-sidecar", "discoverProjects failed", {
          message: err instanceof Error ? err.message : String(err),
        });
        json(res, 200, { projects: [] });
      });
    return true;
  }

  if (method === "GET" && url.startsWith("/sessions")) {
    const target = new URL(url, `http://${ctx.host}`).searchParams.get("cwd");
    if (!target) {
      json(res, 400, { error: "missing cwd query param" });
      return true;
    }
    const requestedAgent = new URL(url, `http://${ctx.host}`).searchParams.get("chatAgent");
    // An omitted chatAgent means coding history; chat callers identify one
    // agent or request the combined, recency-sorted "all" listing; the
    // reserved value "motion" lists Motion sessions.
    void listSidecarSessions(target, requestedAgent, ctx.paths.sessionsDir)
      .then((sessions) => json(res, 200, { sessions }))
      .catch(() => json(res, 200, { sessions: [] }));
    return true;
  }

  if (method === "GET" && url.startsWith("/files")) {
    const q = new URL(url, `http://${ctx.host}`).searchParams.get("q") ?? "";
    void searchProjectFiles(ctx.cwd, q)
      .then((files) => json(res, 200, { files }))
      .catch((err) => {
        log("ERROR", "app-sidecar", "searchProjectFiles failed", {
          message: err instanceof Error ? err.message : String(err),
        });
        json(res, 200, { files: [] });
      });
    return true;
  }

  // Markdown transcript export for the app's download button. Serialized
  // here rather than in the webview because the webview's transcript model
  // deliberately keeps tool activity in the LiveToolPanel — exporting from
  // there would hand the user a coding session with the coding missing.
  // `?name=1` asks for the suggested filename only (the save dialog needs it
  // before there is a path), so the markdown never crosses IPC twice.
  if (method === "GET" && (url === "/export" || url.startsWith("/export?"))) {
    const query = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    const st = ctx.session.getState();
    const filename = defaultExportFilename(ctx.mode);
    if (query.get("name") === "1") {
      json(res, 200, { filename });
      return true;
    }
    const markdown = sessionToMarkdown(
      {
        mode: ctx.mode,
        cwd: ctx.cwd,
        provider: st.provider,
        model: st.model,
        ...(st.sessionId ? { sessionId: st.sessionId } : {}),
      },
      ctx.session.getMessages(),
      { toolDetail: parseToolDetail(query.get("tools")) },
    );
    json(res, 200, { filename, markdown });
    return true;
  }

  return false;
}
