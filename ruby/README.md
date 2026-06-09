# EZ Agent for Ruby

A **project-agnostic** LLM streaming + tool-calling framework for Ruby. Add a
gem, define tools as Ruby classes that wrap your own code, and get a streaming,
multi-turn, tool-calling agent with production hardening — in *any* Ruby context
(Rails, Sinatra, a CLI, a worker, plain Ruby).

This is a faithful Ruby port of [ezcoder](https://github.com/Gahroot/ezcoder)'s
reusable core (`@prestyj/ai` + `@prestyj/agent`), as a standalone gem set with
**zero framework dependencies in core**.

## The two gems

| Gem | Mirrors | Role |
|---|---|---|
| [`ez_llm`](ez_llm/) | `@prestyj/ai` | Unified streaming + providers + events. Standalone, depends only on `net/http` + `json` + `zeitwerk`. |
| [`ez_agent`](ez_agent/) | `@prestyj/agent` | The agent loop + tool execution + hardening. Depends only on `ez_llm`. |

Optional adapter gems build on the core but are never a core dependency — see
the Rails adapter below.

## Rails adapter

[`ez_agent-rails`](ez_agent-rails/) is a mountable Rails engine that adapts the
framework-agnostic loop to a Rails app: ActiveRecord persistence for
conversations / messages / runs, an off-request `RunJob`, live Hotwire/Turbo
streaming (with an Action Cable raw-event fallback), a DB-backed human-in-the-loop
approval gate + durable cancellation, an install generator, and a bundled
dependency-light demo chat UI. Mount it and go:

```ruby
# Gemfile
gem "ez_agent-rails"
```

```bash
rails g ez_agent_rails:install && rails db:migrate
```

See [ez_agent-rails/README.md](ez_agent-rails/README.md) for configuration, the
streaming model, the approval/cancellation endpoints, and a copy-paste UI.

## Quick start

```ruby
require "ez_agent"

# A tool is a thin wrapper over code you already have.
class GetWeather < EZAgent::Tool
  description "Look up current weather."
  param :city, :string, required: true

  def perform(city:)
    Weather.for(city).to_json   # calls your own code, in-process
  end
end

agent = EZAgent::Loop.new(
  provider: :anthropic,
  model: "claude-sonnet-4-6",
  tools: [GetWeather]
)

result = agent.run(
  messages: [{ role: "user", content: "weather in Tokyo?" }],
  credentials: { api_key: ENV["ANTHROPIC_API_KEY"] }
) do |event|
  case event.type
  when :text_delta      then print event.text
  when :tool_call_start then warn "→ #{event.name}"
  end
end

puts result.final_text
```

Run the framework-free example against any provider:

```bash
EZ_PROVIDER=anthropic EZ_MODEL=claude-sonnet-4-6 EZ_API_KEY=sk-ant-... \
  ruby examples/weather_cli.rb "What's the weather in Tokyo and Paris?"
```

## Design properties

- **Tools wrap your own code.** The agent runs in-process, so a tool just calls
  a Ruby method/object directly — a service object, a DB query, an HTTP call,
  anything. No internal API, no sidecar. This is what makes "an AI that can do
  everything your app can" work.
- **Transport- and execution-context agnostic.** The loop yields events to a
  block; the consumer decides what to do with them (stdout, SSE, ActionCable, a
  test array) and where to run (inline, a Thread, a Fiber, a job). Core never
  imports a transport or enqueues a job.
- **Per-tenant credentials.** Keys are passed *per call* (`credentials:`), never
  global config — so one process can serve many tenants/providers.
- **Optional everything advanced.** Approval gate, cancellation, context
  compaction, steering/follow-up, untrusted-content fencing — all opt-in, off by
  default. The minimal path is: define tools, call `run`, consume events.

## Trust model (read this)

By default the framework is **full-trust**, like ezcoder: every tool the model
calls runs without confirmation, and tool output enters history verbatim. For
agents exposed to untrusted content (web pages, user-supplied data) you should
opt into the hardening:

- `requires_confirmation!` on a tool + an `EZAgent::ApprovalGate` → human consent
  before external-write actions (mitigates excessive agency, OWASP LLM06).
- `untrusted!` on a tool + `fence_untrusted: true` → wrap third-party output in a
  data-only fence before it enters history (mitigates prompt injection, LLM01).

## Development

Requires Ruby >= 3.2 (the floor is the lowest version with `Data.define`); CI
tests up to the latest stable (4.0.5).

```bash
cd ez_llm        && rspec   # core: streaming + providers
cd ez_agent      && rspec   # core: agent loop + tools
cd ez_agent-rails && bundle exec rspec  # Rails engine adapter (end-to-end)
```

See [PORTING.md](PORTING.md) for the TS→Ruby mapping and design decisions.

## License

MIT
