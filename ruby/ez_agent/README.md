# ez_agent

A framework-agnostic, streaming, tool-calling agent loop for Ruby. A standalone
port of [`@prestyj/agent`](https://github.com/Gahroot/ezcoder) plus
media-master's production hardening. Depends only on
[`ez_llm`](https://rubygems.org/gems/ez_llm).

## Usage

```ruby
require "ez_agent"

class GetWeather < EZAgent::Tool
  description "Look up current weather."
  param :city, :string, required: true

  def perform(city:)
    Weather.for(city).to_json   # wraps your own code, in-process
  end
end

agent = EZAgent::Loop.new(provider: :anthropic, model: "claude-sonnet-4-6",
                          tools: [GetWeather])

result = agent.run(
  messages: [{ role: "user", content: "weather in Tokyo?" }],
  credentials: { api_key: ENV["ANTHROPIC_API_KEY"] }
) do |event|
  case event.type
  when :text_delta      then print event.text
  when :tool_call_start then warn "→ #{event.name}"
  when :tool_call_end   then warn "← #{event.result}"
  end
end

result.final_text
```

The loop yields events to your block and returns a `Result`. You own concurrency:
run it inline, in a `Thread`, in a Fiber, or inside a job backend.

## Tool macros

```ruby
class PublishPost < EZAgent::Tool
  description "Publish a post to a connected account."
  requires_confirmation!          # gate behind the approval gate (if any)
  untrusted!                       # fence this tool's output (if fencing on)
  sequential!                      # run in source order, no racing
  param :text, :string, required: true
  param :platform, :string, enum: %w[x threads bluesky]

  def perform(text:, platform: "x", context:)   # `context:` is optional
    context.context[:publisher].call(text, platform)
  end
end
```

## Optional hardening

```ruby
# Human-in-the-loop approval for gated tools (off by default).
gate = EZAgent::ApprovalGate.new(
  policy: EZAgent::ToolPolicy.new(requires_confirmation: %w[send_email]),
  decide: ->(req) { my_ui.ask(req) }   # => :allow / :deny / :always_allow
)

agent = EZAgent::Loop.new(
  provider: :anthropic, model: "claude-sonnet-4-6",
  tools: [PublishPost], approval: gate,
  fence_untrusted: true              # wrap `untrusted!` tool output
)
```

## Cancellation

```ruby
token = EZAgent::Cancellation.new
Thread.new { agent.run(messages:, cancellation: token) { |e| ... } }
# elsewhere:
token.abort!   # loop stops at the next turn/tool boundary
```

## Always-on recovery

Ported from the TS loop and always active (pure, framework-free): turn/
continuation budgets, overload/rate-limit backoff, stream-stall → non-streaming
fallback, empty-response retry, context-overflow compaction (via your
`transform_context:`), tool-pairing + thinking-block repair, and head/tail
tool-result truncation.

## Trust model

Default is **full-trust** like ezcoder. Opt into the approval gate +
`fence_untrusted` for agents exposed to untrusted content. See the repo
[README](../README.md#trust-model-read-this).

## License

MIT
