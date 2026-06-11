# frozen_string_literal: true

module EZAgentRails
  # View-side counterpart to {EZAgentRails::DomTargets}: gives templates the same
  # element ids the {Broadcaster} aims its append/replace broadcasts at, so the
  # containers a page renders match what the live stream updates.
  module RunsHelper
    def run_stream_target(run)
      DomTargets.stream(run)
    end

    def run_tools_target(run)
      DomTargets.tools(run)
    end

    def run_status_target(run)
      DomTargets.status(run)
    end

    def run_actions_target(run)
      DomTargets.actions(run)
    end

    def run_confirmation_target(run, confirmation)
      DomTargets.confirmation_frame(run, confirmation.id)
    end

    # Conversation-level streaming targets ────────────────

    def messages_target(conversation)
      DomTargets.messages(conversation)
    end

    def streaming_message_target(conversation)
      DomTargets.streaming_message(conversation)
    end

    # Engine URL helpers resolved through the mounted Engine's route set, so the
    # returned paths carry the host's mount prefix (e.g. `/ez_agent/...`) whether
    # they are built in an engine request OR in an out-of-band Turbo broadcast
    # (rendered via the host's ApplicationController, where the engine's own
    # `*_path` helpers are not in scope). Used by the confirm partial's buttons.
    def ez_agent_routes
      EZAgentRails::Engine.routes.url_helpers
    end

    # Fingerprinted URL for an engine-served JS asset. Appends a content digest
    # (`?v=<digest>`) so the URL changes whenever the file changes — letting the
    # browser cache the asset for a year while still picking up edits immediately.
    # `name` is an {EZAgentRails::AssetsController::ASSETS} key; `path_helper` is
    # the matching route helper symbol (e.g. `:provider_selector_js_path`).
    def ez_agent_asset_path(name, path_helper)
      base = ez_agent_routes.public_send(path_helper)
      digest = EZAgentRails::AssetsController.digest_for(name)
      digest ? "#{base}?v=#{digest}" : base
    end

    # ── Provider badge helpers ─────────────────────────────

    # Provider display name for the badge on assistant messages.
    PROVIDER_DISPLAY = {
      "anthropic" => "Claude",
      "openai"    => "GPT",
      "gemini"    => "Gemini",
      "moonshot"  => "Kimi",
      "glm"       => "GLM",
      "minimax"   => "MiniMax",
      "xiaomi"    => "MiMo",
      "deepseek"  => "DeepSeek",
      "openrouter" => "OpenRouter"
    }.freeze

    # Emoji icon per provider for the message badge.
    PROVIDER_ICONS = {
      "anthropic" => "circle",
      "openai"    => "circle",
      "gemini"    => "circle",
      "moonshot"  => "moon",
      "glm"       => "box",
      "minimax"   => "diamond",
      "xiaomi"    => "smartphone",
      "deepseek"  => "anchor",
      "openrouter" => "shuffle"
    }.freeze

    # Render a small provider badge for an assistant message.
    def provider_badge(message)
      provider = message.provider_name
      return "" unless provider

      icon_name = PROVIDER_ICONS[provider] || "bot"
      label = PROVIDER_DISPLAY[provider] || provider.titleize
      model = message.model_name
      text  = model ? "#{label} #{model}" : label
      icon_tag = content_tag(:i, "", data: { lucide: icon_name })
      content_tag(:span, "#{icon_tag} #{text}".html_safe, class: "ez-agent-provider-badge")
    end

    # ── Diagnostics helpers ─────────────────────────────────

    # Render the diagnostics panel for a completed run.
    def diagnostics_panel(run)
      return "" unless run

      turn_latencies = run.turn_latencies || []
      avg_latency = if turn_latencies.any?
                       (turn_latencies.sum { |t| t["latency_ms"].to_i } / turn_latencies.length).round
                     end

      content_tag(:div, class: "ez-agent-diagnostics", data: { controller: "diagnostics" }) do
        toggle = content_tag(:button, "#{content_tag(:i, '', data: { lucide: 'bar-chart-3' })} Diagnostics".html_safe, type: "button",
                             class: "ez-agent-diagnostics__toggle",
                             data: { action: "click->diagnostics#toggle" })
        body   = content_tag(:div, class: "ez-agent-diagnostics__body",
                             data: { diagnostics_target: "body" }) do
          rows = [
            ["Turns",        run.total_turns_display],
            ["Input tokens",  number_with_delimiter(run.input_tokens)],
            ["Output tokens", number_with_delimiter(run.output_tokens)],
            ["Avg latency",   avg_latency ? "#{avg_latency}ms" : "—"],
            ["Retries",       run.retry_count.to_s],
            ["Stream stalls", run.stall_count.to_s],
            ["Total time",    run.total_latency_ms ? "#{run.total_latency_ms}ms" : "—"]
          ]
          rows.map do |label, value|
            content_tag(:div, class: "ez-agent-diagnostics__row") do
              content_tag(:span, label, class: "ez-agent-diagnostics__label") +
              content_tag(:span, value, class: "ez-agent-diagnostics__value")
            end
          end.join.html_safe
        end
        toggle + body
      end
    end
  end
end
