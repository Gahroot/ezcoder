---
"@kenkaiiii/ggcoder": patch
---

Fix Windows compatibility across project discovery, shell execution, MCP and LSP.

- **Projects and sessions were invisible on Windows.** Every cwd extractor in
  project discovery gated on `cwd.startsWith("/")`, so a `C:\…` session header
  was rejected, discovery fell back to the lossy directory-name decode, and the
  project silently vanished from the picker. Absolute-path detection is now
  platform-agnostic (`C:\…`, `\\server\share\…`, `/…`), and both fallback
  decoders reconstruct real Windows paths.
- **Extended-length paths no longer duplicate a project.** A cwd recorded as
  `\\?\C:\proj` (what Rust's `canonicalize()` produces) is normalized to its
  plain form on read, matching what `encodeCwd` already did on write.
- **`persist` bash mode was completely broken on Windows.** It spawned a bare
  `bash`, but Git for Windows puts `cmd\` on PATH and `bash.exe` in `bin\`, so
  the spawn was always ENOENT. It now reuses the resolved shell, and no longer
  detaches on Windows (which only orphaned the shell past a crash).
- **MCP stdio servers configured with `npx` never connected.** The MCP SDK
  spawns with `shell: false` and Windows' `CreateProcess` ignores `PATHEXT`, so
  the near-universal `{"command": "npx"}` config failed with an opaque
  "Connection closed". The command is now resolved across PATH × PATHEXT.
- **LSP inline diagnostics never appeared on Windows.** Diagnostics are cached
  by `file://` URI; ours kept the drive letter's case while servers emit the
  lowercase form, so every lookup missed and LSP degraded silently.
- **Background processes survived cancellation.** `killProcessTree` used a
  POSIX-only negative pid, leaving a timed-out command's whole descendant tree
  running. It now uses `taskkill /T /F`, resolved from `SystemRoot` rather than
  PATH.
- `find`/`grep` glob patterns containing backslashes now match (backslash is
  picomatch's escape character, never a separator).
- **Session persistence was broken on Windows.** `syncFile` opened the file
  read-only (`"r"`) and then called `fsync`, but Windows implements fsync as
  `FlushFileBuffers`, which requires a handle with WRITE access and fails with
  `EPERM` on a read-only one. Every durable session write funnels through that
  helper, so saving sessions, archiving cold sessions and writing redirects all
  threw. It now opens `"r+"`, and a failed flush is non-fatal (network shares
  and container overlays can reject fsync outright — losing durability there is
  acceptable, refusing to save the user's session is not).
