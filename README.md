# EZCoder Framework

<p align="center">
  <strong>Modular TypeScript framework for building LLM-powered apps. From raw streaming to full coding agent.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@prestyj/cli"><img src="https://img.shields.io/npm/v/@prestyj/cli?style=for-the-badge" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://youtube.com/@kenkaidoesai"><img src="https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube"></a>
  <a href="https://skool.com/kenkai"><img src="https://img.shields.io/badge/Skool-Community-7C3AED?style=for-the-badge" alt="Skool"></a>
</p>

Three packages. Each one works on its own. Stack them together and you get a full coding agent.

| Package | What it does | README |
|---|---|---|
| [`@prestyj/ai`](https://www.npmjs.com/package/@prestyj/ai) | Unified LLM streaming API across four providers | [packages/ai](packages/ai/README.md) |
| [`@prestyj/agent`](https://www.npmjs.com/package/@prestyj/agent) | Agent loop with multi-turn tool execution | [packages/agent](packages/agent/README.md) |
| [`@prestyj/cli`](https://www.npmjs.com/package/@prestyj/cli) | CLI coding agent with OAuth, tools, and TUI | [packages/ezcoder](packages/ezcoder/README.md) |

```
@prestyj/ai (standalone)
  └─► @prestyj/agent (depends on ai)
        └─► @prestyj/cli (depends on both)
```

---

## Which package do I need?

| You want to... | Use |
|---|---|
| Stream LLM responses across providers with one API | [`@prestyj/ai`](packages/ai/README.md) |
| Build an agent that calls tools and loops autonomously | [`@prestyj/agent`](packages/agent/README.md) |
| Use a ready-made CLI coding agent | [`@prestyj/cli`](packages/ezcoder/README.md) |

Each package works on its own. Install only what you need.

```bash
npm i @prestyj/ai          # Just the streaming layer
npm i @prestyj/agent       # Streaming + agent loop
npm i -g @prestyj/cli     # The full CLI
```

---

## For developers

```bash
git clone https://github.com/Gahroot/ezcoder.git
cd ezcoder
pnpm install
pnpm build
```

TypeScript 5.9 + pnpm workspaces + Ink 6 + React 19 + Vitest 4 + Zod v4

---

## Community

- [YouTube @kenkaidoesai](https://youtube.com/@kenkaidoesai) - tutorials and demos
- [Skool community](https://skool.com/kenkai) - come hang out

---

## License

MIT

---

<p align="center">
  <strong>Less bloat. More coding. Four providers. Three packages. One framework.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@prestyj/cli"><img src="https://img.shields.io/badge/Install-npm%20i%20--g%20%40prestyj%2Fcli-blue?style=for-the-badge" alt="Install"></a>
</p>
