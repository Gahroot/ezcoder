<h1 align="center">@prestyj/core</h1>

<p align="center">
  <strong>Model list, sign-in and local model discovery for apps built on @prestyj/ai.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@prestyj/core"><img src="https://img.shields.io/npm/v/@prestyj/core?style=for-the-badge&color=blue" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@prestyj/core"><img src="https://img.shields.io/npm/dm/@prestyj/core?style=for-the-badge&color=2ecc71" alt="npm downloads per month"></a>
  <a href="https://github.com/Gahroot/ezcoder/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg?style=for-the-badge" alt="AGPL-3.0 License"></a>
</p>

@prestyj/core is the shared base under [EZ Coder](https://github.com/Gahroot/ezcoder)'s desktop app and CLI. It knows every supported model (context window, image and video support, thinking levels), signs users in to their AI subscriptions, keeps those credentials fresh, and finds models running on the user's machine.

It has no UI and no agent loop. Its only framework dependency is [`@prestyj/ai`](https://www.npmjs.com/package/@prestyj/ai).

## Install

```bash
npm install @prestyj/core
```

Needs Node.js 22 or newer. Ships ESM and CommonJS builds with TypeScript types.

## Quick start

```ts
import { AuthStorage, discoverLocalModels, getModel } from "@prestyj/core";

const model = getModel("claude-sonnet-5-5");
console.log(model?.contextWindow, model?.supportsImages); // 1000000 true

// Credentials saved by `ezcoder login` or the EZ Coder app, refreshed when they expire.
const auth = new AuthStorage();
const token = await auth.resolveToken("anthropic");

// Models on a running Ollama server.
const { models } = await discoverLocalModels();
console.log(models.map((m) => m.id));
```

`resolveToken()` throws `NotLoggedInError` when the provider has no saved credentials.

## What's inside

| Area            | Main exports                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Models          | `getModel`, `getAllModels`, `getModelsForProvider`, `getDefaultModel`, `getContextWindow`, `MODELS`                           |
| Thinking levels | `getSupportedThinkingLevels`, `getMaxThinkingLevel`, `getDefaultThinkingLevel`, `getNextThinkingLevel`                        |
| Credentials     | `AuthStorage`: reads and writes `~/.ezcoder/auth.json`, refreshes sign-in tokens, safe across processes                            |
| Sign-in         | `loginChatGPT` (Sign in with ChatGPT), `refreshChatGPTToken`, `revokeChatGPTSignIn`; `loginClaudeCode` for Claude             |
| Provider list   | `AUTH_PROVIDERS`: each provider's name, models, sign-in methods and plan/pay-per-token keys, ready for a login screen         |
| Local models    | `discoverLocalModels`, `probeEndpoint`: Ollama by default, plus LM Studio, llama.cpp, vLLM or any custom URL                  |
| Plan usage      | `fetchSubscriptionUsage`: remaining Kimi Code plan usage (Claude reports its own; ChatGPT's is at chatgpt.com/settings/usage) |
| Paths           | `getAppPaths`: every file EZ Coder keeps under `~/.ezcoder/`                                                                       |
| Other           | Logger, file lock, Telegram bot, voice transcription, auto-update                                                             |

`AuthStorage` shares `~/.ezcoder/auth.json` with EZ Coder, so a user who has signed in there is already signed in to your tool. Pass a different file path to the constructor to keep your own.

## Lighter imports

Two subpaths load only what they need, which keeps startup fast:

```ts
import { getModel } from "@prestyj/core/models";
import { getAppPaths } from "@prestyj/core/paths";
```

Voice transcription uses two optional dependencies (`@huggingface/transformers`, `ogg-opus-decoder`). Everything else works without them.

## The EZCoder Framework

| Package                                                                  | What it does                                                                     |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| [@prestyj/ai](https://www.npmjs.com/package/@prestyj/ai)       | One streaming API for every provider                                             |
| [@prestyj/agent](https://www.npmjs.com/package/@prestyj/agent) | The agent loop: runs tools and feeds results back to the model                   |
| **@prestyj/core**                                                   | Model list, sign-in and stored credentials, local model discovery (this package) |
| [@prestyj/cli](https://www.npmjs.com/package/@prestyj/cli)   | The EZ Coder coding agent: CLI, tools and sessions                               |

Source, issues and the desktop app: [github.com/Gahroot/ezcoder](https://github.com/Gahroot/ezcoder).

## License

[AGPL-3.0-only](https://github.com/Gahroot/ezcoder/blob/main/LICENSE). You can build on it; if you distribute your changes or run them as a network service, share their source under the same license.
