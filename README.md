# GG Coder

<p align="center">
  <strong>A desktop coding agent that opens a real window on every project you're working on — and a modular TypeScript framework underneath it.</strong>
</p>

<p align="center">
  <a href="https://github.com/KenKaiii/gg-framework/releases/latest"><img src="https://img.shields.io/github/v/release/KenKaiii/gg-framework?style=for-the-badge&label=GG%20Coder%20App&color=7C3AED" alt="GG Coder desktop release"></a>
  <a href="https://www.npmjs.com/package/@kenkaiiii/ggcoder"><img src="https://img.shields.io/npm/v/@kenkaiiii/ggcoder?style=for-the-badge&label=ggcoder%20CLI" alt="ggcoder npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://youtube.com/@kenkaidoesai"><img src="https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube"></a>
  <a href="https://skool.com/kenkai"><img src="https://img.shields.io/badge/Skool-Community-7C3AED?style=for-the-badge" alt="Skool"></a>
</p>

---

# ⭐ GG Coder — the desktop app

**This is the main event.** A Tauri 2 desktop app wrapped around the full ggcoder agent.
Not a chat box with a code theme — every window is its own agent, bound to its own
project folder, running its own tools on your machine.

<p align="center">
  <a href="https://github.com/KenKaiii/gg-framework/releases/latest"><img src="https://img.shields.io/badge/⬇%20Download%20for%20macOS-Apple%20Silicon%20·%20.dmg-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS"></a>
  <a href="https://github.com/KenKaiii/gg-framework/releases/latest"><img src="https://img.shields.io/badge/⬇%20Download%20for%20Windows-.exe%20installer-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Download for Windows"></a>
</p>

Signed and notarized on macOS, and it **updates itself** — new releases arrive in the app.

<p align="center">
  <img src="docs/screenshots/01-home.png" alt="GG Coder home screen" width="900">
</p>

## What makes it different

**One window per project.** Open gg-coder in one window, your client's Next.js app in
another, a Rust experiment in a third. Each window boots its own agent process with its
own cwd, its own model, its own history. Nothing leaks between them. Tile them 2-up or
4-up like macOS fill & arrange and watch three agents work at once.

<p align="center">
  <img src="docs/screenshots/03-projects.png" alt="Project picker listing discovered projects" width="900">
</p>

It also finds projects you've already worked on in **Claude Code and Codex**, not just
gg-coder — pick one and pick up where you left off.

**Watch it work.** The transcript stays prose; tools stream in a pinned panel at the
bottom, so you can see every file it touches and every command it runs without the chat
turning into a wall of JSON. Git branch, uncommitted count, open issues and PRs sit in
the title bar; context %, thinking level and both models sit in the footer.

<p align="center">
  <img src="docs/screenshots/02-chat.png" alt="GG Coder mid-run, with the live tool panel streaming edits and a test run" width="900">
</p>

**Bring your own brain.** Anthropic, OpenAI/Codex, Gemini, Kimi, GLM, MiniMax, DeepSeek,
Xiaomi MiMo, xAI, OpenRouter — OAuth or API key, your choice. Switch models
mid-conversation.

<p align="center">
  <img src="docs/screenshots/04-providers.png" alt="Provider login hub with OAuth and API-key options" width="900">
</p>

**…including the models on your own machine.** Ollama, LM Studio, llama.cpp and vLLM are
auto-discovered on their normal ports — no config, no flags. Real context windows and
capabilities come from the server itself, so a model that can't call tools is flagged
here instead of failing on your first prompt.

<p align="center">
  <img src="docs/screenshots/05-local-models.png" alt="Local model discovery showing a running Ollama server and its models" width="900">
</p>

**It sees.** Drag in a screenshot, paste a design, throw it a video file. Video goes
natively to the models that take it (Gemini 3.x, Kimi K3, MiniMax M3, MiMo-V2.5); for
everything else the agent gets the file and reaches for ffmpeg itself.

**Autopilot + Ken.** Flip Autopilot and Ken — a mentor agent — reviews the work after
each run and pushes it back for another pass. You get a second opinion on your code
without asking for one.

**Plan mode.** Read-only exploration first, a written plan you approve, then execution.
For the changes you don't want it improvising on.

**Real editor smarts.** Every edit is checked by a real language server — TypeScript
ships in the box, no setup — so type errors get caught and fixed in the same turn they're
created. Python, Go, Rust and C/C++ light up if their toolchain is on your PATH.

**MCP, skills, subagents, memory.** Paste any `claude mcp add …` line and it just works.
Spawn isolated subagents for parallel work. Project memory, notes, chat export, prompt
enhancement, slash commands from `.gg/commands/*.md`.

**It knows your quota.** Live subscription usage meter in the title bar — how much of your
5-hour and weekly window you've burned, and when it resets.

**And it's a little bit silly.** XP, ranks and streaks for the work you ship. Sound. ASCII
banners. Webcam gaze focus, if you want your eyes to switch windows for you.

## Run it from source

```bash
git clone https://github.com/KenKaiii/gg-framework.git
cd gg-framework
pnpm install
pnpm --filter @kenkaiiii/ggcoder build   # build the agent sidecar first
cd gg-app && pnpm tauri dev
```

Packaging details (bundled Node runtime, single-file sidecar, code signing) live in
[gg-app/DISTRIBUTION.md](gg-app/DISTRIBUTION.md).

---

# ⌨️ ggcoder — the CLI

The same agent, in your terminal. The app is the face; this is the engine.

```bash
npm i -g @kenkaiiii/ggcoder
ggcoder
```

OAuth login (no API keys to paste), a full Ink TUI, tools, MCP, LSP diagnostics, session
resume. → [packages/ggcoder](packages/ggcoder/README.md)

---

# 🧱 The framework underneath

Every layer is published on its own. Take one, take all of them.

| Package                                                                    | What it does                                                   | README                                           |
| -------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| [`@kenkaiiii/gg-ai`](https://www.npmjs.com/package/@kenkaiiii/gg-ai)       | Unified LLM streaming API across every provider above          | [packages/gg-ai](packages/gg-ai/README.md)       |
| [`@kenkaiiii/gg-agent`](https://www.npmjs.com/package/@kenkaiiii/gg-agent) | Agent loop with multi-turn tool execution                      | [packages/gg-agent](packages/gg-agent/README.md) |
| [`@kenkaiiii/gg-core`](https://www.npmjs.com/package/@kenkaiiii/gg-core)   | Shared foundation — model registry, OAuth, auth storage, paths | [packages/gg-core](packages/gg-core/README.md)   |
| [`@kenkaiiii/ggcoder`](https://www.npmjs.com/package/@kenkaiiii/ggcoder)   | CLI coding agent + the app sidecar                             | [packages/ggcoder](packages/ggcoder/README.md)   |
| [`@kenkaiiii/gg-boss`](https://www.npmjs.com/package/@kenkaiiii/gg-boss)   | Orchestrator that drives many ggcoder workers from one chat    | [packages/gg-boss](packages/gg-boss/README.md)   |

```
@kenkaiiii/gg-ai (standalone)
  └─► @kenkaiiii/gg-agent
        └─► @kenkaiiii/gg-core
              ├─► @kenkaiiii/ggcoder ──► GG Coder desktop app ⭐
              └─► @kenkaiiii/gg-boss
```

The desktop app adds **zero** forked agent logic. Windows, IPC and UI live in `gg-app/`;
everything else is the same spine the CLI runs.

## Which piece do I need?

| You want to...                                          | Use                                                                               |
| ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| A coding agent with a real UI, on every project at once | **[Download GG Coder](https://github.com/KenKaiii/gg-framework/releases/latest)** |
| A coding agent in your terminal                         | `npm i -g @kenkaiiii/ggcoder`                                                     |
| Drive many agents across projects from one chat         | `npm i -g @kenkaiiii/gg-boss`                                                     |
| Build an agent that calls tools and loops autonomously  | `npm i @kenkaiiii/gg-agent`                                                       |
| Stream LLM responses across providers with one API      | `npm i @kenkaiiii/gg-ai`                                                          |

---

## For developers

```bash
pnpm install
pnpm build      # tsc across all packages
pnpm check      # typecheck
pnpm test       # vitest
```

TypeScript 5.9 · pnpm workspaces · Tauri 2 · React 19 · Vite 7 · Ink 6 · Vitest 4 · Zod v4

---

## Community

- [YouTube @kenkaidoesai](https://youtube.com/@kenkaidoesai) — tutorials and demos
- [Skool community](https://skool.com/kenkai) — come hang out

---

## License

MIT

---

<p align="center">
  <strong>Less bloat. More coding. Every model. Every project. One window each.</strong>
</p>

<p align="center">
  <a href="https://github.com/KenKaiii/gg-framework/releases/latest"><img src="https://img.shields.io/badge/⬇%20Get%20GG%20Coder-macOS%20%26%20Windows-7C3AED?style=for-the-badge" alt="Download GG Coder"></a>
  <a href="https://www.npmjs.com/package/@kenkaiiii/ggcoder"><img src="https://img.shields.io/badge/CLI-npm%20i%20--g%20%40kenkaiiii%2Fggcoder-blue?style=for-the-badge" alt="Install ggcoder"></a>
</p>
