<pre align="center">
   ▄██████▄     ▄██████▄        ▄████████  ▄██████▄  ████████▄     ▄████████    ▄████████
  ███    ███   ███    ███      ███    ███ ███    ███ ███   ▀███   ███    ███   ███    ███
  ███    █▀    ███    █▀       ███    █▀  ███    ███ ███    ███   ███    █▀    ███    ███
 ▄███         ▄███             ███        ███    ███ ███    ███  ▄███▄▄▄      ▄███▄▄▄▄██▀
▀▀███ ████▄  ▀▀███ ████▄       ███        ███    ███ ███    ███ ▀▀███▀▀▀     ▀▀███▀▀▀▀▀&nbsp;&nbsp;
  ███    ███   ███    ███      ███    █▄  ███    ███ ███    ███   ███    █▄  ▀███████████
  ███    ███   ███    ███      ███    ███ ███    ███ ███   ▄███   ███    ███   ███    ███
  ████████▀    ████████▀       ████████▀   ▀██████▀  ████████▀    ██████████   ███    ███
                                                                               ███    ███
</pre>

https://github.com/user-attachments/assets/8f264af5-c757-4dcc-b622-b9e0edf36f89

<p align="center">
  <strong>Cause the other agents piss me off.</strong>
</p>

<p align="center">
  <a href="https://github.com/KenKaiii/gg-framework/releases/latest"><img src="https://img.shields.io/github/v/release/KenKaiii/gg-framework?style=for-the-badge&label=Download&color=b0b6ff" alt="GG Coder desktop release"></a>
  <a href="https://github.com/KenKaiii/gg-framework/stargazers"><img src="https://img.shields.io/github/stars/KenKaiii/gg-framework?style=for-the-badge&label=Stars&color=yellow" alt="Star GG Coder on GitHub"></a>
  <a href="https://www.npmjs.com/package/@kenkaiiii/ggcoder"><img src="https://img.shields.io/npm/v/@kenkaiiii/ggcoder?style=for-the-badge&label=CLI&color=blue" alt="ggcoder npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://youtube.com/@kenkaidoesai"><img src="https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube"></a>
  <a href="https://skool.com/kenkai"><img src="https://img.shields.io/badge/Skool-Community-b0b6ff?style=for-the-badge" alt="Skool"></a>
</p>

GG Coder is a desktop AI app for coding, chatting, running whole goals and making videos. Pick your AI provider, open as many windows as you need, and tell it what you want done. Less babysitting, more getting things done.

## Why GG Coder

**The leanest coding agent I've tested.** I raced GG Coder against 9 other coding agents, all running the same model with the same settings. Every agent finished every task. GG tied the two fastest and was the cheapest of all 10.

| Agent              | Time for the full suite | Usage per suite* | GG Coder compared          |
| ------------------ | ----------------------- | ---------------- | -------------------------- |
| **GG Coder**       | **116 s**               | **$0.095**       |                            |
| Goose              | 114 s                   | $0.105           | same speed, 9% less usage  |
| GitHub Copilot CLI | 119 s                   | $0.127           | same speed, 25% less usage |
| Claude Code        | 135 s                   | $0.179           | 14% faster, 47% less usage |
| Crush              | 150 s                   | $0.191           | 23% faster, 50% less usage |
| Oh My Pi           | 150 s                   | $0.144           | 23% faster, 34% less usage |
| Factory Droid      | 158 s                   | $0.131           | 27% faster, 28% less usage |
| Deep Agents        | 181 s                   | $0.207           | 36% faster, 54% less usage |
| Qwen Code          | 196 s                   | $0.300           | 41% faster, 68% less usage |
| Hermes Agent       | 245 s                   | $0.140           | 53% faster, 32% less usage |

On a subscription, less usage means more work out of your plan. The same allowance covers about **1.9x** the coding it would in Claude Code, and about **1.5x** what it would in Oh My Pi.

<sub>*Usage priced at Claude Haiku 5.5 API rates; on a subscription it comes out of your plan's limit instead. Tested 18 October 2026: 7 coding tasks (bug fix, debugging, feature, refactors, a code question) × 5 runs per agent, Claude Haiku 5.5 on every agent, thinking set the same for all, each agent on its latest release from the previous 72 hours. Only differences that held up across all runs are claimed. Pi, OpenCode and Kilo CLI couldn't run because Anthropic rejected them on a subscription. Results on other models and bigger projects may differ.</sub>

## What you get

- **Code:** a coding agent that plans, edits, runs your tests and tells you straight what it verified. Plan mode lets you review the plan before anything changes.
- **Ken Autopilot:** reviews the coding work and keeps it going until it's actually done and checked, so you don't have to babysit it.
- **GG Goals:** hand over a whole goal and walk away. It agrees the approach with you, then does the work, splitting big independent parts across a team of workers that run side by side, and keeps you posted until the goal is met. It works on any folder, not just code: research, documents, plans.
- **Agent Steroids:** a local library of real, current open-source code. Your agent looks up how real projects solve a problem instead of guessing, offline and with no limits.
- **Chat:** conversations that remember context.
- **GG Motion:** turns your ideas into videos.
- **Your models, your way:** sign in with Claude, ChatGPT, Gemini, Grok or Kimi subscriptions, use API keys for OpenAI, Anthropic, DeepSeek, GLM, MiniMax, OpenRouter and more, or run local models. A usage meter shows how much of your plan you've used.
- **Plugs into your workflow:** connect MCP servers, and drive GG from Telegram, voice notes included.

## Get started

1. Install GG Coder:

   **macOS (Apple Silicon):** [Download the latest release](https://github.com/KenKaiii/gg-framework/releases/latest) and open the `.dmg`.

   **Windows:** [Download the latest release](https://github.com/KenKaiii/gg-framework/releases/latest) and run the `.exe` installer.

   **Development:** With Node.js, pnpm, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) installed:

   ```bash
   git clone https://github.com/KenKaiii/gg-framework.git
   cd gg-framework
   pnpm install
   pnpm build
   pnpm --filter gg-app tauri dev
   ```

2. Open the app, connect your AI provider, and pick Code, Chat, or Motion.

## Build with the framework

Want the engine without the desktop app? Use the same packages in your own apps. Install just what you need.

- [**@kenkaiiii/gg-ai**](packages/gg-ai/README.md): Connect to AI providers and stream responses.
- [**@kenkaiiii/gg-agent**](packages/gg-agent/README.md): Build agents that use your tools and work through tasks.
- [**@kenkaiiii/gg-core**](packages/gg-core/README.md): Model selection, authentication, and local model discovery.
- [**@kenkaiiii/ggcoder**](packages/ggcoder/README.md): The coding agent, sessions, and tools behind the app and CLI.

For your own agent, start here:

```bash
npm install @kenkaiiii/gg-ai @kenkaiiii/gg-agent
```

The package links above cover setup and usage. MIT licensed, so you can build on it.

## Learn with me

Come build with me in my [Skool community](https://skool.com/kenkai). Get help, share what you're making, and learn how to get more out of AI.
