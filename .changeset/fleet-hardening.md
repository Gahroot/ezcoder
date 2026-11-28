---
"@prestyj/cli": patch
---

Fleet hardening: Docker args for jobs are now an allow-list, compose jobs need a node labelled `compose`, secrets are for deploy jobs only, nodes refuse non-Tailscale addresses without `--insecure-bind`, a deploy is never sent to a second node, a remote agent's edits survive a failed final sync, and damaged state files are set aside instead of being reset.
