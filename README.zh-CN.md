<p align="center">
  <img src="ezcoder-app/icon-source.png" alt="EZ Coder app icon" width="128">
</p>

<p align="center">
  <img src="docs/art/home.png" alt="EZ Coder desktop home screen">
</p>

<p align="center">
  <strong>因为别的 AI 编程 agent 实在让我火大。</strong>
</p>

<p align="center">
  <a href="README.md">English</a> | <strong>简体中文</strong> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.es.md">Español</a> | <a href="README.pt-BR.md">Português</a> | <a href="README.de.md">Deutsch</a> | <a href="README.fr.md">Français</a>
</p>

<p align="center">
  <a href="https://github.com/Gahroot/ezcoder/releases/latest"><img src="https://img.shields.io/github/v/release/Gahroot/ezcoder?style=for-the-badge&label=Download&color=b0b6ff" alt="EZ Coder desktop release"></a>
  <a href="https://github.com/Gahroot/ezcoder"><img src="https://img.shields.io/github/stars/Gahroot/ezcoder?style=for-the-badge&label=Stars&color=yellow" alt="Star EZ Coder on GitHub"></a>
  <a href="https://github.com/Gahroot/ezcoder/releases"><img src="https://img.shields.io/github/downloads/Gahroot/ezcoder/total?style=for-the-badge&label=App%20downloads&color=2ecc71" alt="Desktop app downloads"></a>
  <a href="https://www.npmjs.com/package/@prestyj/cli"><img src="https://img.shields.io/npm/dm/@prestyj/cli?style=for-the-badge&label=CLI%20downloads&color=2ecc71" alt="ezcoder npm downloads per month"></a>
  <a href="https://www.npmjs.com/package/@prestyj/cli"><img src="https://img.shields.io/npm/v/@prestyj/cli?style=for-the-badge&label=CLI&color=blue" alt="ezcoder npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg?style=for-the-badge" alt="AGPL-3.0 License"></a>
  <a href="https://prestyj.com"><img src="https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube"></a>
  <a href="https://www.skool.com/raid"><img src="https://img.shields.io/badge/Skool-Free%20community-b0b6ff?style=for-the-badge" alt="Free Skool community"></a>
</p>

<sub>本页为翻译版本，内容可能晚于英文版更新。如有出入，以 [English README](README.md) 为准。</sub>

EZ Coder 是一款桌面编程 agent，让你已经付费的 AI 订阅发挥更大价值。

> ⭐ **如果 EZ Coder 帮你省了时间或钱，请给它点个 Star。** 这是其他开发者发现它的主要方式。

## 为什么选择 EZ Coder

- **同样的套餐，干更多活。** 在同一模型上与 20 个 agent 比拼，它最快、最省。完成同样的工作，Claude Code 多用了 169%。
- **真实代码，而不是瞎猜。** Agent Steroids 在你的电脑上搜索真实、最新的开源代码。不用受限速的 MCP 服务器，没有使用上限。
- **完成就意味着已验证。** Nolan Autopilot 会一直推进工作，直到真正验证通过。
- **新手也能规范上线。** 写代码只是其中一部分。一键检查安全、合规、数据安全、无障碍、测试等，再加上项目健康评分（Project health），你不需要知道该问什么。
- **用你自己的订阅。** Claude、ChatGPT、Kimi Code、MiniMax、MiMo 套餐，任意 API 密钥或本地模型。

| Agent              | 完成整套任务用时 | 每套任务用量 | 用时对比 EZ Coder | 用量对比 EZ Coder |
| ------------------ | ---------------- | ------------ | ----------------- | ----------------- |
| **EZ Coder**       | **102 s**        | **$0.014**   |                   |                   |
| Codewhale          | 112 s            | $0.022       | 慢 10%            | 多 58%            |
| Goose              | 132 s            | $0.020       | 慢 29%            | 多 46%            |
| GitHub Copilot CLI | 136 s            | $0.025       | 慢 33%            | 多 83%            |
| Kimi Code          | 138 s            | $0.024       | 慢 36%            | 多 74%            |
| Claude Code        | 142 s            | $0.037       | 慢 39%            | 多 169%           |
| ForgeCode          | 155 s            | $0.042       | 慢 52%            | 多 204%           |
| Dirac              | 160 s            | $0.029       | 慢 57%            | 多 114%           |
| Crush              | 165 s            | $0.037       | 慢 62%            | 多 173%           |
| Factory Droid      | 167 s            | $0.025       | 慢 64%            | 多 83%            |
| Mistral Vibe       | 169 s            | $0.036       | 慢 66%            | 多 164%           |
| DeepSeek-Reasonix  | 170 s            | $0.027       | 慢 67%            | 多 99%            |
| Oh My Pi           | 170 s            | $0.031       | 慢 67%            | 多 123%           |
| Xum                | 172 s            | $0.041       | 慢 69%            | 多 203%           |
| Docker Agent       | 173 s            | $0.021       | 慢 70%            | 多 51%            |
| Qwen Code          | 177 s            | $0.049       | 慢 74%            | 多 257%           |
| Prime Agent        | 190 s            | $0.029       | 慢 86%            | 多 111%           |
| Hermes Agent       | 190 s            | $0.027       | 慢 87%            | 多 100%           |
| Deep Agents        | 201 s            | $0.041       | 慢 97%            | 多 198%           |
| jcode              | 380 s            | $0.178       | 慢 274%           | 多 1196%          |

<sub>表格：2026 年 11 月 4 日的一次完整比拼。20 个 agent，均为当前稳定版（EZ Coder v0.102.0），7 个任务，每个跑 5 次（共 700 次），全部使用 Claude Haiku 5.5 和相同的思考设置。每个 agent 拿到相同的提示词，每次运行都使用项目的全新副本，并以原始状态运行（EZ Coder 也一样）：只用自带的内置提示词和工具，没有技能、插件、MCP 服务器或自定义指令。任务使用小型测试项目，外加一个关于 Vite 代码库（v8.3.5）的问题，因此没有 agent 是在处理自己的代码。只有隐藏测试通过或答案正确时，该次运行才算数。</sub>

## 还包括

- **GG Goals：** 交出一个完整目标，由一组 worker 帮你完成。
- **Chat：** 能记住上下文的对话。
- **GG Motion：** 把你的想法变成视频。

## 快速开始

1. 安装 EZ Coder：

   **macOS（Apple Silicon）：** [下载最新版本](https://github.com/Gahroot/ezcoder/releases/latest)，然后打开 `.dmg`。

   **Windows：** [下载最新版本](https://github.com/Gahroot/ezcoder/releases/latest)，然后运行 `.exe` 安装程序。

   **Linux（x86_64）：** [下载最新版本](https://github.com/Gahroot/ezcoder/releases/latest)，然后安装 `.deb`（`sudo apt install ./GG*.deb`）或 `.rpm`（`sudo dnf install ./GG*.rpm`）。

   **开发：** 安装好 Node.js、pnpm 和 [Tauri 前置依赖](https://v2.tauri.app/start/prerequisites/) 后：

   ```bash
   git clone https://github.com/Gahroot/ezcoder.git
   cd ezcoder
   pnpm install
   pnpm build
   pnpm --filter ezcoder-app tauri dev
   ```

2. 打开应用，连接你的 AI 服务商，然后选择 Code、Chat 或 Motion。

## 基于框架开发

只想要引擎，不要桌面应用？在你自己的应用里使用同样的包，按需安装。

- [**@prestyj/ai**](packages/ai/README.md): 连接 AI 服务商并流式获取响应。
- [**@prestyj/agent**](packages/agent/README.md): 构建能使用你的工具、逐步完成任务的 agent。
- [**@prestyj/core**](packages/core/README.md): 模型选择、身份验证和本地模型发现。
- [**@prestyj/cli**](packages/cli/README.md): 应用和 CLI 背后的编程 agent、会话和工具。

构建你自己的 agent，从这里开始：

```bash
npm install @prestyj/ai @prestyj/agent
```

上面的包链接里有安装和使用说明。采用 AGPL-3.0 许可：你可以在此基础上开发；如果你分发修改后的版本，或将其作为网络服务运行，需要以相同许可证公开相应源代码。

## 参与贡献

欢迎提交 bug 报告、想法和 pull request。开始前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和[行为准则](CODE_OF_CONDUCT.md)。

## 跟我一起学

来我的 [Skool 社区](https://www.skool.com/raid)一起构建。获取帮助、分享你的作品，学习如何更好地利用 AI。

## Star 历史

<a href="https://star-history.com/#Gahroot/ezcoder&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Gahroot/ezcoder&amp;type=Date&amp;theme=dark">
    <img alt="EZ Coder Star 历史图表" src="https://api.star-history.com/svg?repos=Gahroot/ezcoder&amp;type=Date">
  </picture>
</a>

<p align="center">如果 EZ Coder 对你有用，⭐ 点个 Star，让更多人发现它。</p>
