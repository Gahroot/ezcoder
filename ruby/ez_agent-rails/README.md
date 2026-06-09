# ez_agent-rails

A mountable [Rails](https://rubyonrails.org) engine that adapts the
framework-agnostic [`ez_agent`](../ez_agent) loop to a Rails application:
ActiveRecord persistence for conversations / messages / runs, a configurable
per-tenant credentials resolver, and an install generator.

Its hard dependencies are `ez_agent`, `rails`, and `turbo-rails` (for live
browser streaming). You supply the tools; the bundled `RunJob` runs the loop
off-request, or you can still own concurrency and run it in a thread/inline.

## Install

Add to your Gemfile:

```ruby
gem "ez_agent-rails"
```

Then run the installer:

```bash
rails g ez_agent_rails:install
rails db:migrate
```

This copies the migration, drops `config/initializers/ez_agent_rails.rb`, and
mounts the engine at `/ez_agent`.

## Configure

```ruby
EZAgentRails.configure do |config|
  config.default_provider = :anthropic
  config.default_model    = "claude-sonnet-4-20250514"

  # Per-tenant auth: ->(provider, context) { { api_key:, base_url: } }
  config.credentials_resolver = lambda do |provider, context|
    { api_key: context[:account].api_key_for(provider) }
  end

  config.tools = [MyApp::Tools::SearchDocs]
  config.fence_untrusted = true
end
```

The default resolver reads `Rails.application.credentials[provider][:api_key]`
then the `<PROVIDER>_API_KEY` env var.

## Demo chat UI

The engine ships a complete, dependency-light chat UI so you can see the whole
adapter work end-to-end without writing any front-end code. It is **Hotwire/Turbo
only — no JS build step, no importmap, no asset pipeline**: the engine serves
Turbo's prebuilt runtime straight from the `turbo-rails` gem at
`GET /ez_agent/turbo.js`, which the demo layout loads as a single ES module.

Mounted routes (under the engine's mount prefix, `/ez_agent` by default):

```
GET  /ez_agent/conversations        # list conversations + start a new one
GET  /ez_agent/conversations/:id    # the live chat page
POST /ez_agent/conversations        # create a conversation
```

The chat page (`conversations#show`) renders the message history, a prompt form
that posts to `RunsController#create`, and an active-run turbo-frame. Submitting
a prompt swaps the new run's frame in, which `turbo_stream_from`s itself and
live-renders streamed text, tool calls, pending **Approve / Deny / Always**
confirmation cards, and a **Stop** button — all driven by the `Broadcaster`.

To actually call a tool, register one in the initializer. The engine bundles an
example tool so the demo works out of the box:

```ruby
EZAgentRails.configure do |config|
  config.default_provider = :anthropic
  config.default_model    = "claude-sonnet-4-20250514"
  config.tools = [EZAgentRails::Demo::GetWeather]  # demo example — a plain-Ruby tool
end
```

`EZAgentRails::Demo::GetWeather` (in `app/tools/ez_agent_rails/demo/`) is a
minimal `EZAgent::Tool` wrapping an in-memory lookup — copy it as the template
for your own tools (which wrap real service objects / DB / HTTP). For browser
streaming the host app must mount Action Cable (`mount ActionCable.server =>
"/cable"`); Turbo's bundled consumer connects there automatically.

## Models

- `EZAgentRails::Conversation` — `has_many :messages`, `has_many :runs`.
  - `#to_llm_messages` → the `[{ role:, content: }, ...]` array `EZAgent::Loop#run` expects.
  - `#append_message(hash)` / `#append_messages(array)` — persist framework message Hashes.
- `EZAgentRails::Message` — `role`, `content` (JSON: String or content-block Array), `position`.
- `EZAgentRails::Run` — `belongs_to :conversation`; `status` enum
  (`running`/`succeeded`/`failed`/`aborted`); `provider`; `model`;
  `input_tokens`/`output_tokens`; `error_message`; `aborted_at`.
  - `#record_result(result)` / `#record_failure(error)` / `#record_aborted(result)` finalize a run.
  - `#request_stop!` stamps `aborted_at` (durable cooperative cancellation).
- `EZAgentRails::ToolConfirmation` — `belongs_to :run`; `tool_name`; `args` (JSON);
  `tool_call_id`; `status` enum (`pending`/`allow`/`deny`/`always_allow`). One row
  per gated tool call the agent wants to make.

## Off-request execution + live streaming

The engine ships a background job, a Turbo/Hotwire broadcaster, an Action Cable
channel, and a controller so a run executes off the request cycle and streams
its agent events to the browser as they happen.

```ruby
conversation = EZAgentRails::Conversation.create!
run = conversation.runs.create!(
  provider: EZAgentRails.configuration.default_provider.to_s,
  model: EZAgentRails.configuration.default_model
)

# Enqueue the loop off-request. The job appends the prompt, runs the loop, and
# streams every event to the browser; it persists each tool result as it
# completes plus the final assistant message and usage, and marks the run
# succeeded/failed. A reloaded conversation therefore replays the tool calls the
# agent made, not just its final answer.
EZAgentRails::RunJob.perform_later(run.id, "Summarize this repo.")
```

Or go through the controller (mounted at `/ez_agent` by default):

```
POST /ez_agent/conversations/:conversation_id/runs   # enqueues RunJob, returns the run frame
GET  /ez_agent/runs/:id                              # show a run (HTML or JSON)
```

### Subscribing the page (Hotwire — primary path)

Render the run frame (the controller's `create`/`show` already do) and the page
subscribes with a single helper — no custom JS:

```erb
<%= turbo_stream_from run %>
<div id="<%= dom_id(run) %>">
  <div id="<%= run_status_target(run) %>"><%= run.status %></div>
  <div id="<%= run_tools_target(run) %>"></div>   <%# tool frames appended here %>
  <div id="<%= run_stream_target(run) %>"></div>  <%# text deltas appended here %>
</div>
```

`EZAgentRails::Broadcaster` maps each `EZAgent::Event` to a `<turbo-stream>`
broadcast on the run's per-run stream: text/thinking deltas **append** into the
stream target, each tool call **appends** a frame that is **replaced** in place
when it finishes, and retry/error/agent_done **replace** the status line. The
event → DOM mapping lives in the partials under `app/views/ez_agent_rails/runs/`.

### Minimal custom UI (copy-paste)

Don't want the bundled demo? A working chat is two files. A controller that shows
a conversation:

```ruby
# app/controllers/chats_controller.rb
class ChatsController < ApplicationController
  def show
    @conversation = EZAgentRails::Conversation.find(params[:id])
    @run = @conversation.runs.order(:id).last
  end
end
```

And its view — a message list, a prompt form posting to the engine's
`RunsController#create`, and the active-run frame the run streams into:

```erb
<%# app/views/chats/show.html.erb %>
<% engine = EZAgentRails::Engine.routes.url_helpers %>

<div id="messages">
  <% @conversation.messages.order(:position).each do |m| %>
    <p><strong><%= m.role %>:</strong> <%= m.to_llm_message[:content] %></p>
  <% end %>
</div>

<turbo-frame id="active_run">
  <% if @run %><%= render "ez_agent_rails/runs/run", run: @run %><% end %>
</turbo-frame>

<%= form_with url: engine.conversation_runs_path(@conversation),
              data: { turbo_frame: "active_run" } do |f| %>
  <%= f.text_area :prompt %>
  <%= f.submit "Send" %>
<% end %>
```

The `runs/run` partial renders `turbo_stream_from run` plus the stream / tools /
status containers the `Broadcaster` targets, so streamed text, tool calls,
confirmation cards, and the Stop button all appear with no custom JS. Make sure
Hotwire/Turbo is loaded on the page (importmap, your bundler, or the demo's
`GET /ez_agent/turbo.js`).

### Raw JSON (fallback path)

Non-Hotwire consumers can subscribe to `EZAgentRails::RunChannel` for the same
events as structured JSON instead of rendered HTML:

```js
consumer.subscriptions.create(
  { channel: "EZAgentRails::RunChannel", run_id: runId },
  { received(event) { /* { type, seq, ... } */ } }
)
```

## Human-in-the-loop approval + cooperative cancellation

Both are OPTIONAL and off by default. Turn the gate on in the initializer:

```ruby
EZAgentRails.configure do |config|
  config.approval_enabled      = true   # wire the gate into RunJob
  config.approval_poll_interval = 0.5   # seconds between row polls
  config.approval_timeout       = 300   # seconds before an unanswered prompt is denied
end
```

Mark the tools that need consent (in their `EZAgent::Tool` subclass):

```ruby
class SendEmail < EZAgent::Tool
  requires_confirmation!
  # ...
end
```

Now when the agent (running inside `RunJob`, off-request) wants to call a gated
tool, the gate parks an `EZAgentRails::ToolConfirmation` row (status `pending`),
broadcasts an Approve / Deny / Always card to the page, and **blocks** the job
until a separate web request records the decision:

```
POST /ez_agent/confirmations/:id   # params: decision = allow | deny | always_allow
POST /ez_agent/runs/:id/stop       # cooperative cancellation (stamps aborted_at)
```

The gate never hangs the job: a stopped run (`aborted_at`) or an elapsed
`approval_timeout` both resolve a pending prompt to `deny`. `always_allow` is
sticky for the rest of the run.

`POST /runs/:id/stop` is durable: it stamps `aborted_at`, which
`EZAgentRails::Cancellation#aborted?` reads, so a run executing in another
process/thread stops at its next turn/tool boundary and is marked `aborted`.

## Driving the loop yourself

The job is optional — you can still own concurrency and the transport:

```ruby
loop = EZAgent::Loop.new(
  provider: run.provider.to_sym,
  model: run.model,
  tools: EZAgentRails.configuration.tools,
  fence_untrusted: EZAgentRails.configuration.fence_untrusted
)

result = loop.run(
  messages: conversation.to_llm_messages,
  credentials: EZAgentRails.credentials_for(run.provider),
  &EZAgentRails::Broadcaster.new(run)
)

conversation.append_message(result.message)
run.record_result(result)
```

## Development

```bash
cd ruby/ez_agent-rails
bundle install
bundle exec rspec
```
