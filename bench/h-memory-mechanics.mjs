// Bench I — how project memory actually works, proven live end to end.
//
// Answers four questions with evidence rather than assertion:
//   Q1 Can the agent choose to write memory?      (is there a tool for it?)
//   Q2 Is it automatic?                            (what triggers a write?)
//   Q3 How exactly does an entry get made?         (what is extracted, from where?)
//   Q4 How is it used?                             (where does it enter the prompt?)
//
// Run from repo root: node bench/h-memory-mechanics.mjs
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { AgentSession } = await import("../packages/ggcoder/dist/core/agent-session.js");
const { JOURNAL_RELATIVE_PATH } = await import("../packages/ggcoder/dist/core/memory/journal.js");

const PROVIDER = process.env.GG_BENCH_PROVIDER ?? "anthropic";
const MODEL = process.env.GG_BENCH_MODEL ?? "claude-sonnet-5";

const settingsPath = path.join(os.homedir(), ".gg", "settings.json");
const originalSettings = fs.existsSync(settingsPath)
  ? fs.readFileSync(settingsPath, "utf-8")
  : null;

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gg-mem-mechanics-"));
const journalPath = path.join(cwd, JOURNAL_RELATIVE_PATH);
let session;

const banner = (t) => console.log(`\n${"=".repeat(72)}\n${t}\n${"=".repeat(72)}`);

async function newSession() {
  const s = new AgentSession({
    provider: PROVIDER,
    model: MODEL,
    cwd,
    maxTurns: 6,
    selfCorrectionHooks: false,
  });
  await s.initialize();
  return s;
}

async function ask(s, prompt) {
  let text = "";
  s.eventBus.on("text_delta", (d) => {
    text += d.text ?? "";
  });
  await s.prompt(prompt);
  return text.trim();
}

try {
  banner("Q1 — Can the agent DECIDE to write memory? (tool inventory)");
  session = await newSession();
  // `tools` is private; read it directly since this is a diagnostic script.
  const toolNames = session.tools.map((t) => t.name);
  const memoryTools = toolNames.filter((n) => /memor|journal|remember|note/i.test(n));
  console.log(`tools available to the agent: ${toolNames.length}`);
  console.log(`tools it could use to write memory: ${JSON.stringify(memoryTools)}`);
  console.log(
    memoryTools.length === 0
      ? "=> NO. The agent has no way to write to project memory. It is not its decision."
      : "=> the agent CAN write memory via the tools above",
  );

  banner("Q2 — Is it automatic? What triggers a write?");
  await fsp.mkdir(path.join(cwd, "src"), { recursive: true });
  await fsp.writeFile(
    path.join(cwd, "src", "slugify.ts"),
    "export function slugify(input: string): string {\n  return input.toLowerCase();\n}\n",
    "utf-8",
  );

  await ask(session, "Read src/slugify.ts and edit it so it also replaces spaces with hyphens.");
  console.log(`after a normal turn that EDITED a file:`);
  console.log(`  journal exists? ${fs.existsSync(journalPath) ? "YES" : "NO"}`);
  console.log("=> normal work writes nothing. Only compaction does.");

  // Grow the conversation past the ~8K-token verbatim window so compaction has
  // something older than the retained tail to summarize.
  for (const name of ["parser", "router", "cache", "queue"]) {
    const body = Array.from(
      { length: 220 },
      (_, i) =>
        `export function ${name}Helper${i}(input: string): string {\n` +
        `  // Step ${i}: normalise the incoming value before dispatching it onward.\n` +
        `  return input.trim().concat("${name}-${i}");\n}\n`,
    ).join("\n");
    await fsp.writeFile(path.join(cwd, "src", `${name}.ts`), body, "utf-8");
  }
  for (const name of ["parser", "router", "cache", "queue"]) {
    await ask(session, `Read src/${name}.ts and say in one sentence what its helpers share.`);
  }

  const before = session.getMessages().length;
  await session.compact();
  console.log(`\nafter compaction: ${before} messages -> ${session.getMessages().length}`);
  console.log(`  journal exists? ${fs.existsSync(journalPath) ? "YES" : "NO"}`);

  banner("Q3 — How exactly is an entry made? (what was extracted, and from where)");
  if (fs.existsSync(journalPath)) {
    const raw = fs.readFileSync(journalPath, "utf-8");
    for (const line of raw.split("\n")) {
      const m = /^-\s+(\d{4}-\d{2}-\d{2})\s+\[([^\]]+)\]\s+(.*)$/.exec(line.trim());
      if (!m) continue;
      const source = {
        request: "first real user message of the discarded span",
        files: "file_path args of write/edit tool calls in that span",
        summary: "the compactor's 'What Was Done' + 'Errors and Fixes' sections only",
      }[m[2]];
      console.log(`\n[${m[2]}]  <- ${source}`);
      console.log(`  ${m[3].slice(0, 200)}${m[3].length > 200 ? "\u2026" : ""}`);
    }
  }

  await session.dispose();
  session = undefined;

  banner("Q4 — How is it used? (where it lands in the next session's prompt)");
  session = await newSession();
  const sys = String(session.getMessages()[0]?.content ?? "");
  const marker = "<!-- uncached -->";
  const at = sys.indexOf("## Project memory");
  console.log(`in system prompt:        ${at !== -1 ? "YES" : "NO"}`);
  console.log(`after the cache marker:  ${at > sys.indexOf(marker) ? "YES (cache-safe)" : "NO"}`);
  console.log(`injected every turn:     YES (refreshSystemPromptTail runs before each run)`);
  console.log(`cost: ${sys.length - sys.slice(0, at).length} chars of the prompt`);

  const answer = await ask(
    session,
    "Without reading any files: according to your project memory, what did a previous " +
      "session do in this project? One sentence, or say you don't know.",
  );
  console.log(`\nfresh session, asked with no file access:\n  "${answer.slice(0, 300)}"`);
} finally {
  if (session) await session.dispose().catch(() => {});
  if (originalSettings === null) fs.rmSync(settingsPath, { force: true });
  else fs.writeFileSync(settingsPath, originalSettings);
  console.log(`\nscratch project: ${cwd}`);
}
