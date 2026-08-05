---
"@kenkaiiii/ggcoder": minor
---

Share MCP connections and language servers across sessions instead of spawning a set per session.

A daemon runs many sessions at once — one per window, plus Ken chat and Ken autopilot within each — and each used to spawn its own child process for every MCP server and every language server. Measured on a four-window daemon: 34 processes and 3.3 GB, most of it identical work duplicated.

- **MCP connections are now pooled per process** and reference counted, so one stdio child serves every session and exits when the last releases it. Sharing is the default for stdio servers; `shared: false` opts out a server that keeps per-caller state, and HTTP servers are never pooled because their auth and session id are per-connection. Elicitation is routed to the session whose tool call is in flight, and cancelled rather than guessed when that is ambiguous. A pooled server that exits on its own is retired from the pool, so the next session reconnects instead of inheriting a dead connection.
- **Language servers are now pooled per (server, project root)**, so two windows open on one repo share a single tsserver stack instead of running two. Servers left unused for five minutes are reclaimed, which also releases roots that no window has open.
- **tsserver runs two processes per root instead of four**, by disabling the syntax server and automatic typing acquisition — both exist for an interactive editor and are unused here — and caps its heap at the VS Code default.
