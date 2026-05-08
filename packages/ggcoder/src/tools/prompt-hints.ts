/**
 * One-line prompt hints for each tool. These are shown in the system prompt's
 * Tools section to orient the model. Full parameter docs live on each tool's
 * JSON schema description (sent separately via the tool definition), so these
 * hints stay short and focus on non-obvious usage.
 */
export const TOOL_PROMPT_HINTS: Record<string, string> = {
  read: "Read file contents. Use offset/limit for large files.",
  write: "Create or fully rewrite a file. Must read first if it exists. Prefer edit for changes.",
  edit: "Surgical edits via { old_text, new_text } pairs. Copy `old_text` verbatim from the read — no paraphrasing, no `...`. Each must match exactly once. Must read first.",
  bash: "Run shell commands. CWD is the project root. Set run_in_background=true for long processes.",
  find: "Find files/dirs by name pattern. Faster than bash find, respects .gitignore.",
  grep: "Regex search across files. Use for usages, definitions, imports.",
  ls: "List directory contents.",
  web_fetch: "Fetch a URL (docs, endpoints, external resources).",
  web_search: "Search the web. Use before web_fetch to find pages.",
  task_output: "Read new output from a background process by id.",
  task_stop: "Stop a background process by id.",
  tasks:
    "Manage the Ctrl+T task pane (add/list/done/remove). Only when the user explicitly asks. Do NOT auto-run.",
  subagent: "Delegate focused, isolated subtasks (research, parallel exploration).",
  skill: "Invoke a named skill for specialized instructions.",
  "mcp__kencode-search__searchCode":
    'Literal/regex search across 2M+ public repos (Sourcegraph). Use for ANY pattern in source: APIs, config layouts (vite.config.ts, package.json), shell idioms, markdown structure, project conventions. Filters: language[], repo ("owner/name"), path. Tip: peek=true returns just paths+counts for cheap triage. Regex is RE2 — no lookahead/lookbehind/backrefs; multi-line needs (?s).',
  enter_plan: "Enter plan mode for read-only research + planning on complex multi-file tasks.",
  exit_plan: "Submit your plan for user review and exit plan mode.",
};

/** Tools always rendered when no explicit tool list is provided. */
export const DEFAULT_TOOL_NAMES: readonly string[] = [
  "read",
  "write",
  "edit",
  "bash",
  "find",
  "grep",
  "ls",
  "web_fetch",
  "task_output",
  "task_stop",
  "tasks",
  "subagent",
  "skill",
  "mcp__kencode-search__searchCode",
  "enter_plan",
  "exit_plan",
];
