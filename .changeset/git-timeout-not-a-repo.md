---
"@kenkaiiii/ggcoder": patch
---

The titlebar no longer shows a project as "not a git repo, 0 changed files" when git is just slow to answer. On a busy machine, git could miss GG's 2-second limit when a window opened, and that timeout was reported as "not a repo" with nothing to correct it until the next run. GG now treats a timeout as unknown, and re-reads the git state in the background with more time.
