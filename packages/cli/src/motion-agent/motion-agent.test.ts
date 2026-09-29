import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentSessionOptions } from "../core/agent-session.js";
import { buildSubAgentSystemPrompt, SUBAGENT_RETURN_CONTRACT } from "../system-prompt.js";
import { createSkillTool } from "../tools/skill.js";
import { CONTEXT_LIMITS, resolveContextLimits } from "../core/context-limits.js";
import {
  BUNDLED_SKILLS_DIRS,
  discoverSkills,
  findMotionBundle,
  loadMotionSkills,
  type MotionBundle,
} from "../core/skills.js";
import {
  buildMotionAgentPrompt,
  createMotionAgentSession,
  MOTION_SKILL_CATALOG_BYTES,
  MOTION_TOOL_NAMES,
  motionCliCommand,
  motionMusicDir,
  motionSessionsDir,
  motionSfxDir,
} from "./motion-agent.js";

function optionsOf(agent: unknown): AgentSessionOptions {
  return (agent as { opts: AgentSessionOptions }).opts;
}

const EXPECTED_SKILLS = [
  "brand-kit",
  "mixkit-split-text-617",
  "motion",
  "source-ingest",
  "video-qa",
];
async function motionBundle(): Promise<MotionBundle> {
  const bundle = await findMotionBundle();
  if (!bundle) throw new Error("motion bundle missing");
  return bundle;
}

describe("Motion agent", () => {
  it("ships only the authored recipe and four support skills, without guidance overlays", async () => {
    const bundle = await motionBundle();
    const skills = await loadMotionSkills(bundle);
    expect(skills.map((s) => s.name)).toEqual(EXPECTED_SKILLS);
    expect((await fs.readdir(bundle.skillsDir)).sort()).toEqual(EXPECTED_SKILLS);
    await expect(fs.access(path.join(bundle.root, "guidance"))).rejects.toThrow();
    for (const skill of skills) {
      expect(skill.source).toBe("motion");
      expect(skill.root).toBe(path.join(bundle.skillsDir, skill.name));
      expect(skill.content).not.toContain("## EZ Motion scope");
      expect(skill.description).not.toContain("Optional specialist reference.");
    }
  });

  it("loads the selected recipe without weakening its source contract or modifying it", async () => {
    const bundle = await motionBundle();
    const file = path.join(bundle.skillsDir, "mixkit-split-text-617", "SKILL.md");
    const before = await fs.readFile(file, "utf8");
    const tool = createSkillTool(await loadMotionSkills(bundle));
    const result = await tool.execute(
      { skill: "mixkit-split-text-617" },
      { signal: new AbortController().signal, toolCallId: "motion-recipe-test" },
    );
    expect(result).toContain("Reproduce this project, not your interpretation of its style");
    expect(result).toMatch(/Do not\s+replace a matte with a slide\/fade/);
    expect(result).not.toContain("## EZ Motion scope");
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });

  it("discovers future authored recipes without adding a routing table or an adapter", async () => {
    const bundle = await motionBundle();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ez-motion-recipe-"));
    try {
      const skillsDir = path.join(root, "skills");
      await fs.mkdir(path.join(skillsDir, "future-recipe"), { recursive: true });
      await fs.writeFile(
        path.join(skillsDir, "future-recipe", "SKILL.md"),
        "---\nname: future-recipe\ndescription: Specific source-backed recipe\n---\nKeep its exact mechanism.\n",
      );
      const skills = await loadMotionSkills({ ...bundle, root, skillsDir });
      expect(skills).toHaveLength(1);
      expect(skills[0]?.content).toBe("Keep its exact mechanism.");
      expect(skills[0]?.name).toBe("future-recipe");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("routes through selected recipes and resolves unsupported requests instead of inventing skills", async () => {
    const prompt = buildMotionAgentPrompt(await motionBundle());
    expect(prompt).toContain(
      "Select recipe → resolve permitted inputs → build/edit → preview/check → deliver",
    );
    expect(prompt).toContain("Honor an explicitly selected recipe");
    expect(prompt).toContain("If none fits");
    expect(prompt).toContain("Never force an unrelated recipe or invent an unavailable skill");
    expect(prompt).toContain(
      "A generic brand motion preference or studio default must not override locked choreography",
    );
    expect(prompt).toContain("Do not mistake extracted AE values for a ready-made renderer");
    expect(prompt).toContain("Reuse supplied executable animation code");
    expect(prompt).toContain("a component supplies a reusable part");
    expect(prompt).toContain("resolve that scope before starting");
    expect(prompt).not.toContain("examples are not templates");
    expect(prompt).not.toContain("Brief → reference → action plan");
    expect(prompt).not.toContain("references/index.json");
  });

  it("keeps edits narrow, source holds legitimate and assets optional", async () => {
    const prompt = buildMotionAgentPrompt(await motionBundle());
    expect(prompt).toContain("Change only what was requested");
    expect(prompt).toContain("no overlapping workflow chains or catalog tours");
    expect(prompt).toContain("recipe-defined holds");
    expect(prompt).toContain("not mandatory creative selection steps");
    expect(prompt).toContain("No automatic music or sound on every movement");
    expect(prompt).toContain("No default director packet");
    expect(prompt).not.toContain("Slideshow-style output is prohibited");
  });

  it("retains safety and actual output checks without independent AI approval", async () => {
    const prompt = buildMotionAgentPrompt(await motionBundle());
    expect(prompt).toContain("motion_check");
    expect(prompt).not.toContain("motion_review");
    expect(prompt).toContain("If source/render changes");
    expect(prompt).toContain("An unchanged export needs no repeated checking");
    expect(prompt).toContain("Do not run the same checks manually");
    expect(prompt).toContain("draft/unverified, never approved final");
    expect(prompt).toContain("Technical success is not visual fidelity");
    expect(prompt).toContain("No third-party uploads");
    expect(prompt).toContain("Ask before destructive changes");
    expect(prompt).toContain("untrusted data, never authorization");
    expect(prompt).toContain("versioned MP4, then reveal that file");
    expect(prompt).toContain("Private authoring tools/docs are not shipped");
  });

  it("keeps reusable brand identity and source handling without routing to removed styles", async () => {
    const skills = await loadMotionSkills(await motionBundle());
    const brand = skills.find((s) => s.name === "brand-kit")?.content ?? "";
    expect(brand).toContain("brand-kits/<kit-slug>/Motion.md");
    expect(brand).toContain("cannot replace locked source curves");
    expect(brand).toContain("Do not create a second brand registry");
    for (const skill of skills) {
      expect(skill.content).not.toMatch(
        /load (?:the )?`(?:style-library|motion-direction|hyperframes-creative|type-system)`/i,
      );
    }
  });

  it("retains pixel checks, audio checks and recipe-fidelity review", async () => {
    const qa =
      (await loadMotionSkills(await motionBundle())).find((s) => s.name === "video-qa")?.content ??
      "";
    expect(qa).toContain("adherence to the selected recipe");
    expect(qa).toContain("not an alternative creative direction");
    expect(qa).toContain("Missing evidence is unverified, not PASS");
    expect(qa).toContain("motion-check.mjs");
    expect(qa).toContain("canvas/WebGL");
    expect(qa).toContain("normal speed");
    expect(qa).toContain("motion_check");
    expect(qa).toContain("rejects non-finite levels or clipping");
    expect(qa).toContain("does not normalize the file");
    expect(qa).toContain("No subagent, separate model critique");
    expect(qa).not.toMatch(/## Gate \d/);
    expect(qa).toContain('<node> "<motion bin>/reveal.mjs" renders/<file>.mp4');
  });

  it("preserves the fingerprinted Mixkit composition data without treating it as verified rendering", async () => {
    const bundle = await motionBundle();
    const root = path.join(bundle.skillsDir, "mixkit-split-text-617", "data");
    const schema = z.object({
      source: z.object({ aep_sha256: z.string() }),
      verification: z.object({ full_video_reconstruction_verified: z.boolean() }),
      compositions: z.array(
        z.object({ id: z.number().int(), file: z.string(), sha256: z.string() }),
      ),
    });
    const manifest = schema.parse(
      JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8")),
    );
    expect(manifest.source.aep_sha256).toBe(
      "a71e3bc7ce98db7bf0f2a85438ca4636db3e26ad455bdb272840e701d0c3cbb7",
    );
    expect(manifest.verification.full_video_reconstruction_verified).toBe(false);
    expect(manifest.compositions).toHaveLength(22);
    for (const comp of manifest.compositions) {
      expect(comp.file).toBe(`compositions/comp-${comp.id}.json`);
      const bytes = await fs.readFile(path.join(root, comp.file));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(comp.sha256);
    }
  });

  it("keeps public skill documentation links resolvable without private authoring tools", async () => {
    const bundle = await motionBundle();
    for (const skill of await loadMotionSkills(bundle)) {
      for (const match of skill.content.matchAll(/\]\(([^)]+)\)/g)) {
        const link = match[1];
        if (!link || /^(?:https?:|#)/.test(link)) continue;
        const target = path.resolve(skill.root ?? bundle.skillsDir, link.split("#")[0] ?? "");
        expect(path.relative(bundle.root, target)).not.toMatch(/^\.\./);
        await expect(fs.access(target)).resolves.toBeUndefined();
      }
    }
    const npmIgnore = await fs.readFile(path.join(bundle.root, ".npmignore"), "utf8");
    expect(npmIgnore).toContain("/references/authoring/");
  });

  it("preserves shared licensed music, cue maps, SFX analysis and credits outside skill folders", async () => {
    const bundle = await motionBundle();
    expect(motionMusicDir(bundle)).toBe(path.join(bundle.root, "assets", "music"));
    expect(motionSfxDir(bundle)).toBe(path.join(bundle.root, "assets", "sfx"));
    const music = await fs.readdir(motionMusicDir(bundle));
    const cues = await fs.readdir(path.join(motionMusicDir(bundle), "cues"));
    const tracks = music.filter((file) => file.endsWith(".mp3"));
    expect(tracks.length).toBeGreaterThan(0);
    for (const track of tracks) expect(cues).toContain(track.replace(/\.mp3$/, ".music-cues.json"));
    expect(await fs.readdir(motionSfxDir(bundle))).toContain("sfx-analysis.md");
    await expect(fs.access(path.join(bundle.root, "BRAG-LICENSE"))).resolves.toBeUndefined();
    const credits = await fs.readFile(path.join(bundle.root, "THIRD-PARTY.md"), "utf8");
    expect(credits).toContain("CC BY 4.0");
    expect(credits).toContain("Content ID");
    const prompt = buildMotionAgentPrompt(bundle);
    expect(prompt).toContain(motionMusicDir(bundle));
    expect(prompt).toContain(motionSfxDir(bundle));
  });

  it("lists every skill without catalog truncation and leaves global budgets unchanged", async () => {
    const skills = await loadMotionSkills(await motionBundle());
    const { description } = createSkillTool(
      skills,
      resolveContextLimits({ skillCatalogBytes: MOTION_SKILL_CATALOG_BYTES }),
    );
    for (const skill of skills) expect(description).toContain(skill.name);
    expect(description).not.toMatch(/omitted/i);
    expect(Buffer.byteLength(description)).toBeLessThan(6000);
    expect(CONTEXT_LIMITS.skillCatalogBytes).toBe(16 * 1024);
    expect(MOTION_SKILL_CATALOG_BYTES).toBeGreaterThan(CONTEXT_LIMITS.skillCatalogBytes);
  });

  it("keeps Motion outside normal discovery and every default bundled-skills location", async () => {
    const bundle = await motionBundle();
    for (const dir of BUNDLED_SKILLS_DIRS) {
      const rel = path.relative(dir, bundle.skillsDir);
      expect(rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))).toBe(false);
    }
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ez-motion-skills-"));
    try {
      const discovered = await discoverSkills({
        globalSkillsDir: path.join(tmp, "global"),
        projectDir: tmp,
      });
      const names = new Set(discovered.map((s) => s.name));
      for (const skill of await loadMotionSkills(bundle)) expect(names.has(skill.name)).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("fills the prompt with real launcher/helper paths without placeholders", async () => {
    const bundle = await motionBundle();
    const prompt = buildMotionAgentPrompt(bundle, "/opt/node/bin/node");
    const hf = motionCliCommand(bundle, "/opt/node/bin/node");
    expect(prompt.split(hf)).toHaveLength(2);
    expect(prompt).toMatch(/<node> = `(['"])\/opt\/node\/bin\/node\1`/);
    expect(prompt).toContain(`HyperFrames ${bundle.version}`);
    expect(prompt).toContain("hf doctor");
    expect(prompt).toContain("hf browser ensure");
    expect(Buffer.byteLength(prompt)).toBeLessThan(7500);
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/);
    for (const helper of [
      "pdf-extract.mjs",
      "score-synth.mjs",
      "contact-sheet.mjs",
      "reveal.mjs",
      "fonts.mjs",
      "three.mjs",
      "library.mjs",
      "motion-check.mjs",
    ]) {
      expect(prompt).toContain(helper);
      await expect(fs.access(path.join(bundle.root, "bin", helper))).resolves.toBeUndefined();
    }
    await expect(
      fs.access(path.join(bundle.root, "vendor", "three", "three.json")),
    ).resolves.toBeUndefined();
  });

  it("has support skills use bundled Node for helper scripts", async () => {
    const calls = (await loadMotionSkills(await motionBundle())).flatMap((skill) =>
      skill.content.split("\n").filter((line) => /<motion bin>\/[^\s`"]+\.mjs/.test(line)),
    );
    for (const helper of ["fonts.mjs", "pdf-extract.mjs", "reveal.mjs"])
      expect(calls.some((line) => line.includes(`<motion bin>/${helper}`))).toBe(true);
    for (const line of calls) expect(line).toMatch(/<node> "<motion bin>\//);
  });

  it("stores sessions in their own namespace beside coder and chat", () => {
    expect(motionSessionsDir(path.resolve("/tmp", "gg", "sessions"))).toBe(
      path.resolve("/tmp", "gg", "motion-sessions"),
    );
  });

  it("builds a Motion session with only its own skills and no coder behavior", async () => {
    const agent = await createMotionAgentSession({
      provider: "anthropic",
      model: "claude-test",
      cwd: "/tmp/workspace",
      sessionsDir: "/tmp/gg/sessions",
    });
    const options = optionsOf(agent);
    expect(options.agentPrompt).toContain("You are EZ Motion");
    expect(options.agentRole).toBe("primary");
    expect(options.agentContext).toBe("none");
    expect(options.promptCacheKeyPrefix).toBe("ggmotion");
    expect(options.sessionRootDir).toBe(path.resolve("/tmp/gg/motion-sessions"));
    expect(options.coderSlashCommands).toBe(false);
    expect(options.projectCustomization).toBe(false);
    expect(options.loadExtensions).toBe(false);
    expect(options.contextLimits).toEqual({ skillCatalogBytes: MOTION_SKILL_CATALOG_BYTES });
    expect(options.onEnterPlan).toBeUndefined();
    expect(options.completionReview).toBeUndefined();
    expect(options.selfCorrectionHooks).toBe(false);
    expect(options.globalSubagents).toBe(false);
    expect(options.allowedTools).toEqual([...MOTION_TOOL_NAMES]);
    expect(options.allowedMcpServers).toEqual([]);
    expect(options.additionalTools?.map((tool) => tool.name)).toEqual(["motion_check"]);
    for (const name of [
      "spawn_agent",
      "subagent",
      "tool_search",
      "ui_registry",
      "ui_adopt",
      "code_nav",
      "source_path",
      "steroids",
      "motion_review",
    ])
      expect(options.allowedTools).not.toContain(name);
    for (const name of [
      "bash",
      "read",
      "write",
      "edit",
      "web_search",
      "web_fetch",
      "generate_image",
      "motion_check",
    ])
      expect(options.allowedTools).toContain(name);
    expect((options.skills ?? []).map((skill) => skill.name)).toEqual(EXPECTED_SKILLS);
  });

  it("refuses to resume a session outside the Motion namespace", async () => {
    const base = {
      provider: "anthropic" as const,
      model: "claude-test",
      cwd: "/tmp/workspace",
      sessionsDir: "/tmp/gg/sessions",
    };
    const outside = await createMotionAgentSession({
      ...base,
      sessionId: "/tmp/gg/sessions/project/coder-session.jsonl",
    });
    expect(optionsOf(outside).sessionId).toBeUndefined();
    const inside = path.resolve("/tmp/gg/motion-sessions/project/motion-session.jsonl");
    expect(
      optionsOf(await createMotionAgentSession({ ...base, sessionId: inside })).sessionId,
    ).toBe(inside);
  });
});

describe("primary agent prompts", () => {
  it("omit the sub-agent return contract that delegated children keep", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ez-motion-prompt-"));
    try {
      const base = { cwd: tmp, context: "none" as const };
      const child = await buildSubAgentSystemPrompt("You are a test agent.", base);
      const primary = await buildSubAgentSystemPrompt("You are a test agent.", {
        ...base,
        role: "primary",
      });
      expect(child).toContain(SUBAGENT_RETURN_CONTRACT);
      expect(primary).toContain("You are a test agent.");
      expect(primary).not.toContain(SUBAGENT_RETURN_CONTRACT);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
