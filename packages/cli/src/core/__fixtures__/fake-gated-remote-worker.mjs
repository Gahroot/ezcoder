// Stand-in for `ezcoder --subagent-worker` on a fleet node for Goal worker
// tests. A task "... gate=<file> write a.txt=x" waits until <file> exists,
// then writes the files and completes, so a test can hold many workers
// running at once and release them in a chosen order.
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const emit = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const ack = (frame, extra = {}) =>
  emit({ type: "ack", request_id: frame.request_id, ok: true, ...extra });

const runTask = (task) => {
  const gate = /gate=(\S+)/.exec(task)?.[1];
  const finish = () => {
    const match = /write (.*)$/.exec(task);
    if (match) {
      for (const spec of match[1].split(";")) {
        const [file, content] = spec.split("=");
        fs.mkdirSync(path.dirname(path.join(process.cwd(), file)), { recursive: true });
        fs.writeFileSync(path.join(process.cwd(), file), content ?? "");
      }
    }
    emit({ type: "turn_complete", status: "completed", output: `done: ${task}`, receipt: "ok" });
  };
  if (!gate) return void setTimeout(finish, 10);
  const timer = setInterval(() => {
    if (!fs.existsSync(gate)) return;
    clearInterval(timer);
    finish();
  }, 20);
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.command === "initialize") {
    const sessionPath = path.join(frame.options.sessionRootDir, `fake-${process.pid}.jsonl`);
    ack(frame, { child_session_id: `fake-${process.pid}`, child_session_path: sessionPath });
    return;
  }
  if (frame.command === "start" || frame.command === "followup") {
    ack(frame, { status: "running" });
    runTask(frame.task);
    return;
  }
  if (frame.command === "shutdown") {
    ack(frame);
    process.exit(0);
  }
  ack(frame);
});
