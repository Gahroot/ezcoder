---
"@kenkaiiii/ggcoder": patch
---

Fix three problems found in a long GG Goals run. A worker resumed with `followup_task` now gets folders attached to the goal after it started, so its write tool can reach them instead of the worker editing through the shell. Adding or removing a folder mid-conversation no longer rewrites the cached system prompt (which re-sent ~75k tokens uncached); the model is told through the environment-change note instead. Stale tool output is now pruned only once the context reaches half the compaction limit, since below that each prune re-sent far more uncached tokens than it freed.
