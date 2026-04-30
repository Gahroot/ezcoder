/**
 * Interactive doctor runner.
 *
 * Used by `ggeditor doctor` and the first-run onboarding flow. Walks
 * through actionable items one at a time:
 *
 *   - If the item carries an `installable` hint → ask "Install X? [Y/n]".
 *     Yes → spawn the package manager, stream output live, re-run the
 *     doctor, move on. No → print the manual `fix` text, move on.
 *   - If the item only has a `fix` string (manual setup, env var, etc.)
 *     → print it and move on.
 *
 * The banner matches `runStatus`'s look ("GG Editor — Doctor", orange-
 * bold, two-space indent, dim subline) so the three CLI commands
 * (auth/login/doctor) feel like one product.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import { type DoctorCheck, type DoctorReport, type InstallableHint, runDoctor } from "./doctor.js";
import { renderDoctorReport } from "./doctor-render.js";

const EDITOR_PRIMARY = "#f97316"; // matches login.ts / runStatus
const EDITOR_ACCENT = "#ec4899";
const orange = chalk.hex(EDITOR_PRIMARY);
const pink = chalk.hex(EDITOR_ACCENT);

export interface DoctorRunOptions {
  /** Print the welcome banner instead of the plain doctor banner. */
  onboarding?: boolean;
  /** Show the full inventory and exit (no install prompts). */
  all?: boolean;
  /** Skip every prompt — print the report and exit. Useful in CI. */
  nonInteractive?: boolean;
}

/**
 * Top-level entry. Renders the orange banner, then either
 *   - prints the inventory (`all` or `nonInteractive`), OR
 *   - walks the user through fixable items one at a time.
 */
export async function runDoctorInteractive(opts: DoctorRunOptions = {}): Promise<void> {
  printBanner(opts.onboarding === true);

  // Non-interactive paths: just print and exit.
  if (opts.all || opts.nonInteractive || !process.stdin.isTTY) {
    const report = runDoctor();
    process.stdout.write(
      renderDoctorReport(report, { all: opts.all, onboarding: opts.onboarding }),
    );
    return;
  }

  await walkActionableItems(opts.onboarding === true);
}

// ── Internals ──────────────────────────────────────────────

function printBanner(onboarding: boolean): void {
  const title = onboarding ? "Welcome to GG Editor" : "GG Editor — Doctor";
  process.stdout.write(orange.bold(`\n  ${title}\n`));
  process.stdout.write(
    chalk.dim(
      onboarding
        ? "  One-time environment check. Re-run any time with `ggeditor doctor`.\n\n"
        : "  Environment check. Re-run any time.\n\n",
    ),
  );
}

/**
 * Walk through actionable items in priority order. After each step we
 * re-run the doctor so that successful installs unblock follow-on
 * checks (e.g. installing ffmpeg flips both ffmpeg + ffprobe to OK).
 */
async function walkActionableItems(onboarding: boolean): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Track items the user has explicitly skipped this session so we
  // don't re-ask about them after every successful install.
  const skipped = new Set<string>();

  try {
    for (let step = 0; step < 20; step++) {
      const report = runDoctor();
      const next = pickNextActionable(report, skipped);
      const total = countActionable(report);
      const done = countDone(report);

      if (!next) {
        // Either everything's clean or we've skipped everything we can.
        const cleanEverything = total === done;
        if (cleanEverything) {
          process.stdout.write(
            "  " +
              chalk.green("✓ Nothing to fix. You're all good.") +
              chalk.dim(" Run `ggeditor` to start.\n\n"),
          );
        } else {
          process.stdout.write(
            "  " +
              chalk.dim(
                `Skipped the rest. ${done}/${total} ready. Re-run \`ggeditor doctor\` any time.\n\n`,
              ),
          );
        }
        return;
      }

      const proceed = await handleItem(next, rl, onboarding);
      if (proceed === "skip") skipped.add(next.id);
      if (proceed === "quit") {
        process.stdout.write(chalk.dim("  Done. Re-run `ggeditor doctor` any time.\n\n"));
        return;
      }
    }
    // Safety bound — should never hit this.
    process.stdout.write(
      chalk.dim("  Reached step limit. Re-run `ggeditor doctor` to continue.\n\n"),
    );
  } finally {
    rl.close();
  }
}

type StepResult = "next" | "skip" | "quit";

async function handleItem(
  item: DoctorCheck,
  rl: ReturnType<typeof createInterface>,
  onboarding: boolean,
): Promise<StepResult> {
  // Header: severity + label + detail.
  const tag =
    item.severity === "required" || item.severity === "block"
      ? chalk.red("required")
      : item.status === "warn"
        ? chalk.yellow("needs attention")
        : chalk.yellow("optional");
  process.stdout.write(`  ${tag} · ${chalk.bold(item.label)}  ${chalk.dim("— " + item.detail)}\n`);
  process.stdout.write("  " + chalk.dim(item.unlocks) + "\n\n");

  if (item.installable) {
    return await offerInstall(item, item.installable, rl);
  }

  // No structured installer — print the manual fix and move on.
  if (item.fix) {
    process.stdout.write(chalk.dim("  Fix:\n"));
    for (const line of item.fix.split("\n")) {
      process.stdout.write("    " + chalk.cyan(line) + "\n");
    }
    process.stdout.write("\n");
  }

  // For required items without a structured installer (e.g. auth →
  // `ggeditor login`) we ask whether to keep going. For optional ones
  // we just move on.
  if (item.severity === "required" || item.severity === "block") {
    const ans = await askYN(rl, "  Continue to the next item?", "y");
    return ans ? "next" : "quit";
  }
  // Onboarding mode: pause briefly so the user reads the fix.
  if (onboarding) {
    const ans = await askYN(rl, "  Continue?", "y");
    return ans ? "next" : "quit";
  }
  return "next";
}

async function offerInstall(
  item: DoctorCheck,
  hint: InstallableHint,
  rl: ReturnType<typeof createInterface>,
): Promise<StepResult> {
  const cmdline = `${hint.command} ${hint.args.join(" ")}`;
  process.stdout.write(`  ${chalk.bold(hint.label)}\n`);
  process.stdout.write(`    ${pink(cmdline)}\n`);
  if (hint.needsSudo) {
    process.stdout.write(chalk.dim("    (will prompt for your sudo password)\n"));
  }
  process.stdout.write("\n");

  const yes = await askYN(rl, "  Install now?", "y");
  if (!yes) {
    if (item.fix) {
      process.stdout.write(chalk.dim("  Skipping. To install later:\n"));
      for (const line of item.fix.split("\n")) {
        process.stdout.write("    " + chalk.cyan(line) + "\n");
      }
      process.stdout.write("\n");
    }
    return "skip";
  }

  const exitCode = await spawnInstall(hint);
  if (exitCode === 0) {
    process.stdout.write(chalk.green("  ✓ Installed.\n\n"));
    return "next";
  }
  process.stdout.write(
    chalk.red(`  ✗ Install failed (exit ${exitCode}).`) + chalk.dim(" You can fix it manually:\n"),
  );
  if (item.fix) {
    for (const line of item.fix.split("\n")) {
      process.stdout.write("    " + chalk.cyan(line) + "\n");
    }
  }
  process.stdout.write("\n");
  return "skip";
}

function spawnInstall(hint: InstallableHint): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(hint.command, hint.args, {
      stdio: "inherit", // user sees + interacts with the manager directly
    });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

async function askYN(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  defaultAns: "y" | "n",
): Promise<boolean> {
  const suffix = defaultAns === "y" ? chalk.dim(" [Y/n] ") : chalk.dim(" [y/N] ");
  const raw = (await rl.question(prompt + suffix)).trim().toLowerCase();
  if (raw === "") return defaultAns === "y";
  if (raw === "y" || raw === "yes") return true;
  if (raw === "n" || raw === "no") return false;
  // Anything else: re-ask once, then fall through to default.
  const retry = (await rl.question(chalk.dim('  Please answer "y" or "n": '))).trim().toLowerCase();
  if (retry === "y" || retry === "yes") return true;
  if (retry === "n" || retry === "no") return false;
  return defaultAns === "y";
}

/**
 * Pick the next actionable item (block > required > optional-warn >
 * optional-missing) that the user hasn't already skipped this session.
 * Info-severity items are never returned.
 */
function pickNextActionable(report: DoctorReport, skipped: Set<string>): DoctorCheck | undefined {
  const tiers: Array<{
    severity: DoctorCheck["severity"];
    statuses: DoctorCheck["status"][];
  }> = [
    { severity: "block", statuses: ["missing", "warn"] },
    { severity: "required", statuses: ["missing", "warn"] },
    { severity: "optional", statuses: ["warn"] },
    { severity: "optional", statuses: ["missing"] },
  ];
  for (const tier of tiers) {
    const hit = report.checks.find(
      (c) => c.severity === tier.severity && tier.statuses.includes(c.status) && !skipped.has(c.id),
    );
    if (hit) return hit;
  }
  return undefined;
}

function countActionable(report: DoctorReport): number {
  return report.checks.filter((c) => c.severity !== "info").length;
}

function countDone(report: DoctorReport): number {
  return report.checks.filter((c) => c.severity !== "info" && c.status === "ok").length;
}
