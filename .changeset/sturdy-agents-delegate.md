---
"@kenkaiiii/ggcoder": minor
---

Make sub-agent delegation reliable: ship six bundled agents (bee, owl, researcher, worker, auditor, skeptic) on every install instead of seeding two into `~/.gg/agents`, compose a child's prompt from its agent body PLUS the Tools, project context, return contract and Environment sections rather than replacing everything, resolve a child's model from explicit `model:` frontmatter (`inherit` by default) instead of silently downgrading read-only agents to the cheap tier, expose the agent roster in `spawn_agent`'s schema, validate `tools:` names, and align wait/output budgets with the child's real timeout.
