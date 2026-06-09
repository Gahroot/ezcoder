# ez_llm

Unified, framework-agnostic LLM streaming for Ruby. A standalone, dependency-light
port of [`@prestyj/ai`](https://github.com/Gahroot/ezcoder): one streaming API
across Anthropic, OpenAI, Gemini, and every OpenAI-compatible provider
(Moonshot/Kimi, GLM, MiniMax, Xiaomi/MiMo, DeepSeek, OpenRouter, Qwen).

Depends only on the standard library (`net/http`, `json`) plus `zeitwerk`. No
framework, no vendor SDKs.

## Usage

```ruby
require "ez_llm"

response = EZLLM.stream(
  provider: :anthropic,
  model: "claude-sonnet-4-6",
  messages: [{ role: "user", content: "Say hi in three words." }],
  api_key: ENV["ANTHROPIC_API_KEY"]
) do |event|
  print event.text if event.type == :text_delta
end

response.message    # => { role: "assistant", content: [...] }
response.stop_reason # => "end_turn"
response.usage       # => EZLLM::Usage(input_tokens:, output_tokens:, ...)
```

### Tools

```ruby
schema = EZLLM::ToolSchema.build do
  string :city, required: true, description: "City name"
end

tool = EZLLM::Tool.new(
  name: "get_weather",
  description: "Look up current weather.",
  input_schema: schema.to_json_schema
)

EZLLM.stream(provider: :openai, model: "gpt-5.5", api_key: key,
             tools: [tool], messages: messages) { |e| ... }
```

## What's inside

- **`EZLLM.stream`** — unified dispatch; resolves the provider, fails fast on a
  video-capability mismatch, streams events, returns a `Response`.
- **Providers** — `Anthropic` (raw Messages API + SSE), `OpenAICompatible`
  (Chat Completions; also OpenAI/GLM/Moonshot/DeepSeek/OpenRouter/Xiaomi/MiniMax),
  `Gemini` (Generative Language API). Built-ins auto-register at load.
- **Events** — `Event::TextDelta`, `ThinkingDelta`, `ToolCallDelta`,
  `ToolCallDone`, `ServerToolCall`, `ServerToolResult`, `Done`, `Keepalive`.
- **`ToolSchema`** — a `param` DSL compiling to JSON Schema, with Anthropic
  root-object normalization.
- **`ModelRegistry`** — every provider/model with context windows, output caps,
  thinking levels, and image/video capabilities.
- **`Errors`** — structured `ProviderError` + classifiers (billing, overflow,
  overload, abort, stall, tool-pairing) shared with the agent loop.

## Per-tenant credentials

Credentials are passed **per call** (`api_key:`, `base_url:`, `account_id:`,
`project_id:`) — never global config. One process can serve many tenants and
providers concurrently.

## License

MIT
