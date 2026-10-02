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

I got tired of babysitting AI. Checking everything it wrote. Explaining the same stuff again. Being stuck in one workspace with whatever model someone else picked for me.

So I built the app I actually wanted to use.

GG Coder helps you **write code, chat, and make videos**. Ken Autopilot checks the coding work. Chat remembers context. You pick the AI and open as many windows as you want.

Less babysitting. Less repeating yourself. More getting things done.

**[Download for macOS or Windows](https://github.com/KenKaiii/gg-framework/releases/latest)**

## It writes the code. Ken checks the work.

Tell it what you want to build or fix. It works in your project, edits the files, and runs commands. You can see what it's doing without digging through a wall of output.

Turn on **Ken Autopilot** and a separate AI reviewer checks the work. If Ken finds problems, he sends it back with feedback so the coding agent can fix them.

Generating code isn't the same as finishing the job. That's the whole point. It's still AI, so review the important stuff before you ship, but you aren't the only one checking anymore.

## Chat that doesn't start from zero

I don't want to introduce myself to my AI every five minutes.

Chat can remember things about you, your preferences, and what you're working on across conversations. Less explaining the backstory. More picking up where you left off.

You can see and manage what it remembers too.

## Open another window. And another.

One project doesn't need to hold everything else up.

Have one window building your app, another working on a different project, and another open for chat. Each gets its own session, and you can use different models in different windows.

There's no one-window limit. Your computer still has limits, obviously.

## Your AI, not my choice of AI

Claude, OpenAI, Gemini, Grok, Kimi, GLM, and more. You can also run local models through Ollama or LM Studio.

Pick what works for you. Switch models mid-conversation. Use a supported subscription login or bring your own API key. You don't have to marry one provider to use the app.

## And yes, it makes videos

**GG Motion** is built into the same app.

Tell it what you want to make. It plans the video, builds it, renders it, and checks the result. Product demos, launch videos, explainers, social clips. Then tell it what you want changed.

Not just an app that writes code. An app that helps you make things.

## First project? You're welcome here.

You don't need to learn terminal commands just to get started.

1. [Download the app](https://github.com/KenKaiii/gg-framework/releases/latest). macOS on Apple Silicon or Windows.
2. Connect your AI provider.
3. Pick Code, Chat, or Motion and tell it what you're trying to do.

Plain words are fine. Ask it to explain things. Use plan mode when you want to see the approach before it starts changing code.

## Already know what you're doing?

There's plenty here for you too.

- **Work from your phone.** Connect Telegram to send tasks and voice notes to the app running on your computer.
- **Give it real code to learn from.** [Agent Steroids](https://github.com/KenKaiii/agent-steroids) lets it look up current open-source code locally instead of guessing how a library works.
- **Bring your own setup.** Custom instructions, skills, commands, MCP tools, and local models.
- **Keep an eye on usage.** See usage for supported providers and set up a backup API key alongside a supported subscription.
- **Use the terminal if you prefer.** The CLI runs the same coding engine as the desktop app.

The easy way in isn't a ceiling.

## I update this daily

I use it, something annoys me, I fix it. Or I think of something I wish it could do and add it.

This isn't a finished product sitting on a shelf. I'm in it every day. The app checks for updates, and you can see what's changing in the [releases](https://github.com/KenKaiii/gg-framework/releases).

Found something annoying? [Open an issue](https://github.com/KenKaiii/gg-framework/issues). That's how this thing started in the first place.

## For the terminal people

```bash
npm i -g @kenkaiiii/ggcoder
ggcoder
```

[CLI setup and docs](packages/ggcoder/README.md)

<details>
<summary><strong>The framework and running from source</strong></summary>

The desktop app and CLI share the same engine. The packages are available separately if you want to build on them.

| Package | What it does |
| --- | --- |
| [gg-ai](packages/gg-ai/README.md) | Streaming AI provider connections |
| [gg-agent](packages/gg-agent/README.md) | Agent loop and tool execution |
| [gg-core](https://www.npmjs.com/package/@kenkaiiii/gg-core) | Models, authentication, local models, and shared utilities |
| [ggcoder](packages/ggcoder/README.md) | Coding agent, CLI, and desktop sidecar |

With Node.js, pnpm, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) installed:

```bash
git clone https://github.com/KenKaiii/gg-framework.git
cd gg-framework
pnpm install
pnpm build
pnpm --filter gg-app tauri dev
```

```bash
pnpm check
pnpm test
pnpm lint
```

Desktop packaging and code signing: [gg-app/DISTRIBUTION.md](gg-app/DISTRIBUTION.md).

</details>

## Come hang out

[Tutorials and demos on YouTube](https://youtube.com/@kenkaidoesai) · [Skool community](https://skool.com/kenkai)

MIT licensed. Use it, change it, ship it.
