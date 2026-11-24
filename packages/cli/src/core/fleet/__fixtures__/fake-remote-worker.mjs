// Stand-in for `ezcoder --subagent-worker` on a fleet node: same JSON-lines
// protocol, no model. A task "write a.txt=x;dir/b.txt=y" writes those files in
// the worker's cwd; "hold" keeps the turn running until a queued message.
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

let turns = 0;
let held;
const emit = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const ack = (frame, extra = {}) =>
  emit({ type: "ack", request_id: frame.request_id, ok: true, ...extra });
const complete = (output) => {
  held = undefined;
  emit({ type: "turn_complete", status: "completed", output, receipt: "Receipt (0 calls)" });
};
const runTask = (task) => {
  const match = /write (.*)$/.exec(task);
  if (match) {
    for (const spec of match[1].split(";")) {
      const [file, content] = spec.split("=");
      fs.mkdirSync(path.dirname(path.join(process.cwd(), file)), { recursive: true });
      fs.writeFileSync(path.join(process.cwd(), file), content ?? "");
    }
  }
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.command === "initialize") {
    const sessionPath =
      frame.options.childSessionPath ??
      path.join(frame.options.sessionRootDir, `fake-${process.pid}.jsonl`);
    ack(frame, {
      child_session_id: path.basename(sessionPath, ".jsonl"),
      child_session_path: sessionPath,
      cwd_seen: frame.options.cwd,
      process_cwd: process.cwd(),
      had_roots: frame.options.additionalRoots !== undefined,
      depth: process.env.EZ_SUBAGENT_DEPTH,
      leaked: process.env.SECRET_TOKEN ?? null,
    });
    return;
  }
  if (frame.command === "start" || frame.command === "followup") {
    turns++;
    ack(frame, { status: "running" });
    emit({
      type: "event",
      event: "turn_end",
      payload: { usage: { inputTokens: 1, outputTokens: 1 } },
    });
    if (/hold/.test(frame.task)) {
      held = frame.task;
      return;
    }
    setTimeout(
      () => {
        runTask(frame.task);
        complete(`done ${turns}: ${frame.task}`);
      },
      /slow/.test(frame.task) ? 200 : 10,
    );
    return;
  }
  if (frame.command === "queue_message") {
    ack(frame, { queued: held ? 1 : 0 });
    if (held) {
      runTask(held);
      complete(`done ${turns}: ${held}`);
    }
    return;
  }
  if (frame.command === "interrupt") {
    ack(frame);
    emit({ type: "turn_complete", status: "interrupted", output: "partial", error: "Interrupted" });
    return;
  }
  if (frame.command === "shutdown") {
    ack(frame);
    process.exit(0);
  }
});
