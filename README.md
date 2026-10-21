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
  <a href="https://github.com/Gahroot/ezcoder/releases/latest"><img src="https://img.shields.io/github/v/release/Gahroot/ezcoder?style=for-the-badge&label=Download&color=b0b6ff" alt="EZ Coder desktop release"></a>
  <a href="https://github.com/Gahroot/ezcoder/stargazers"><img src="https://img.shields.io/github/stars/Gahroot/ezcoder?style=for-the-badge&label=Stars&color=yellow" alt="Star EZ Coder on GitHub"></a>
  <a href="https://www.npmjs.com/package/@prestyj/cli"><img src="https://img.shields.io/npm/v/@prestyj/cli?style=for-the-badge&label=CLI&color=blue" alt="ezcoder npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://prestyj.com"><img src="https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube"></a>
  <a href="https://prestyj.com"><img src="https://img.shields.io/badge/Skool-Community-b0b6ff?style=for-the-badge" alt="Skool"></a>
</p>

EZ Coder is a desktop AI app that helps you write code, chat, and make videos. Nolan Autopilot checks the coding work, chat remembers context, and GG Motion creates videos from your ideas. Pick your AI provider, open as many windows as you need, and tell it what you want to do. Less babysitting, more getting things done.

## Get started

1. Install EZ Coder:

   **macOS (Apple Silicon):** [Download the latest release](https://github.com/Gahroot/ezcoder/releases/latest) and open the `.dmg`.

   **Windows:** [Download the latest release](https://github.com/Gahroot/ezcoder/releases/latest) and run the `.exe` installer.

   **Development:** With Node.js, pnpm, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) installed:

   ```bash
   git clone https://github.com/Gahroot/ezcoder.git
   cd ezcoder
   pnpm install
   pnpm build
   pnpm --filter ezcoder-app tauri dev
   ```

2. Open the app, connect your AI provider, and pick Code, Chat, or Motion.

## Build with the framework

Want the engine without the desktop app? Use the same packages in your own apps. Install just what you need.

- [**@prestyj/ai**](packages/ai/README.md): Connect to AI providers and stream responses.
- [**@prestyj/agent**](packages/agent/README.md): Build agents that use your tools and work through tasks.
- [**@prestyj/core**](packages/core/README.md): Model selection, authentication, and local model discovery.
- [**@prestyj/cli**](packages/cli/README.md): The coding agent, sessions, and tools behind the app and CLI.

For your own agent, start here:

```bash
npm install @prestyj/ai @prestyj/agent
```

The package links above cover setup and usage. MIT licensed, so you can build on it.

## Learn with me

Come build with me in my [Skool community](https://prestyj.com). Get help, share what you're making, and learn how to get more out of AI.
