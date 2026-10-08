# @prestyj/core

<p align="center">
  <strong>Model registry, auth storage and local-model discovery. No UI, no agent loop.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@prestyj/core"><img src="https://img.shields.io/npm/v/@prestyj/core?style=for-the-badge" alt="npm version"></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

The shared foundation under EZ Coder's app and CLI. It depends only on [`@prestyj/ai`](../@prestyj/ai/README.md), never on React, Ink or the agent loop.

Part of the [EZCoder Framework](../../README.md) monorepo.

---

## Install

```bash
npm i @prestyj/core
```

---

## What's inside

| Area | Main exports |
|---|---|
| Model registry | `getModel`, `getAllModels`, `getModelsForProvider`, `getDefaultModel`, `getContextWindow` |
| Thinking levels | `getSupportedThinkingLevels`, `getMaxThinkingLevel`, `getDefaultThinkingLevel` |
| Auth storage | `AuthStorage` (reads and writes `~/.ezcoder/auth.json`, refreshes OAuth tokens) |
| OAuth | Anthropic, OpenAI, Gemini, Kimi and xAI login flows |
| Local models | `discoverLocalModels` (Ollama, LM Studio, llama.cpp, vLLM, custom endpoints) |
| Paths | `getAppPaths` (every file under `~/.ezcoder/`) |
| Other | Logger, file lock, usage limits, Telegram, voice transcription, auto-update |

Two lighter subpath entries skip the rest of the package:

```ts
import { getModel } from "@prestyj/core/models";
import { getAppPaths } from "@prestyj/core/paths";
```

---

## Example

```ts
import { AuthStorage, discoverLocalModels, getModel } from "@prestyj/core";

const model = getModel("claude-sonnet-5-5");
console.log(model?.contextWindow);

const auth = new AuthStorage();
const token = await auth.resolveToken("anthropic");

const { models } = await discoverLocalModels();
console.log(models.map((m) => m.id));
```

`AuthStorage` throws `NotLoggedInError` when a provider has no stored credentials.

---

## License

MIT
