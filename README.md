# EZCoder Framework

<p align="center">
  <strong>Modular TypeScript framework for building LLM-powered apps. From raw streaming to full coding agent.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@prestyj/cli"><img src="https://img.shields.io/npm/v/@prestyj/cli?style=for-the-badge&label=ezcoder" alt="ezcoder npm version"></a>
  <a href="https://www.npmjs.com/package/@prestyj/boss"><img src="https://img.shields.io/npm/v/@prestyj/boss?style=for-the-badge&label=ezboss" alt="ezboss npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://prestyj.com"><img src="https://img.shields.io/badge/Website-prestyj.com-2563EB?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Website"></a>
  <a href="https://youtube.com/@kenkaidoesai"><img src="https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube"></a>
  <a href="https://skool.com/kenkai"><img src="https://img.shields.io/badge/Skool-Community-7C3AED?style=for-the-badge" alt="Skool"></a>
</p>

Four packages. Each one works on its own. Stack them together and you get a full coding agent — or an orchestrator that drives many of them at once.

| Package | What it does | README |
|---|---|---|
| [`@prestyj/ai`](https://www.npmjs.com/package/@prestyj/ai) | Unified LLM streaming API across four providers | [packages/ai](packages/ai/README.md) |
| [`@prestyj/agent`](https://www.npmjs.com/package/@prestyj/agent) | Agent loop with multi-turn tool execution | [packages/agent](packages/agent/README.md) |
| [`@prestyj/cli`](https://www.npmjs.com/package/@prestyj/cli) | CLI coding agent (`ezcoder`) with OAuth, tools, and TUI | [packages/cli](packages/cli/README.md) |
| [`@prestyj/boss`](https://www.npmjs.com/package/@prestyj/boss) | Orchestrator (`ezboss`) that drives many ezcoder workers from one chat | [packages/boss](packages/boss/README.md) |

```
@prestyj/ai (standalone)
  └─► @prestyj/agent (depends on ai)
        └─► @prestyj/cli (depends on both)
              └─► @prestyj/boss (orchestrates many ezcoder workers)
```

---

## Which package do I need?

| You want to... | Use |
|---|---|
| Stream LLM responses across providers with one API | [`@prestyj/ai`](packages/ai/README.md) |
| Build an agent that calls tools and loops autonomously | [`@prestyj/agent`](packages/agent/README.md) |
| Use a ready-made CLI coding agent | [`@prestyj/cli`](packages/cli/README.md) |
| Drive many coding agents across multiple projects from one chat | [`@prestyj/boss`](packages/boss/README.md) |

Each package works on its own. Install only what you need.

```bash
npm i @prestyj/ai          # Just the streaming layer
npm i @prestyj/agent       # Streaming + agent loop
npm i -g @prestyj/cli      # The full CLI coding agent (ezcoder)
npm i -g @prestyj/boss     # Multi-project orchestrator (ezboss)
```

---

## Ruby port

The reusable core also ships as a **project-agnostic Ruby gem set** — add a gem,
define tools as Ruby classes that wrap your own code, and get a streaming,
multi-turn, tool-calling agent in any Ruby context (Rails, Sinatra, a CLI, a
worker, plain Ruby). Zero framework dependencies in core. See [`ruby/`](ruby/README.md).

| Gem | Mirrors | Role |
|---|---|---|
| [`ez_llm`](ruby/ez_llm) | `@prestyj/ai` | Unified streaming + providers + events. Depends only on `net/http` + `json` + `zeitwerk`. |
| [`ez_agent`](ruby/ez_agent) | `@prestyj/agent` | The agent loop + tool execution + hardening. Depends only on `ez_llm`. |
| [`ez_agent-rails`](ruby/ez_agent-rails) | — | Mountable Rails engine: ActiveRecord persistence, an off-request job, live Hotwire/Turbo streaming (ActionCable fallback), a human-in-the-loop approval gate, an install generator, and a bundled demo chat UI. |

```ruby
# Gemfile
gem "ez_agent-rails"
```

```bash
rails g ez_agent_rails:install && rails db:migrate   # migration + initializer + engine mount
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

The Ruby port lives under [`ruby/`](ruby/README.md) (Ruby >= 3.2):

```bash
cd ruby/ez_llm        && bundle exec rspec   # core: streaming + providers
cd ruby/ez_agent      && bundle exec rspec   # core: agent loop + tools
cd ruby/ez_agent-rails && bundle exec rspec  # Rails engine adapter (end-to-end)
```

---

## Community

- [prestyj.com](https://prestyj.com) - website
- [YouTube @kenkaidoesai](https://youtube.com/@kenkaidoesai) - tutorials and demos
- [Skool community](https://skool.com/kenkai) - come hang out

---

## License

MIT

---

<p align="center">
  <strong>Less bloat. More coding. Four providers. Four packages. One framework.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@prestyj/cli"><img src="https://img.shields.io/badge/Install-npm%20i%20--g%20%40prestyj%2Fcli-blue?style=for-the-badge" alt="Install ezcoder"></a>
  <a href="https://www.npmjs.com/package/@prestyj/boss"><img src="https://img.shields.io/badge/Orchestrate-npm%20i%20--g%20%40prestyj%2Fboss-7C3AED?style=for-the-badge" alt="Install ezboss"></a>
</p>
