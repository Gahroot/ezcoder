# frozen_string_literal: true

module EZLLM
  module Providers
    # Anthropic Messages API transport (raw HTTP + SSE). Also drives MiniMax's
    # Anthropic-compatible endpoint. Handles OAuth tokens (sk-ant-oat...),
    # adaptive vs budget thinking, prompt-cache control, server tools / web
    # search, and the content_block_* streaming event protocol.
    #
    # Port of providers/anthropic.ts.
    class Anthropic < Base
      VERSION_HEADER = "2023-06-01"
      ENDPOINT_PATH = "/v1/messages"

      def run(&on_event)
        @on_event = on_event
        @oauth = request.api_key.to_s.start_with?("sk-ant-oat")
        body = build_body
        streaming? ? run_streaming(body) : run_buffered(body)
      rescue HTTP::HTTPError => e
        raise translate_http_error(e)
      rescue EZLLM::Error
        raise
      rescue StandardError => e
        raise ProviderError.new(provider_name, e.message, cause: e)
      end

      private

      def base_url
        request.base_url || "https://api.anthropic.com"
      end

      def first_party?
        request.base_url.nil? || request.base_url.include?("api.anthropic.com")
      end

      def headers
        h = {
          "anthropic-version" => VERSION_HEADER,
          "content-type" => "application/json"
        }
        if @oauth
          h["authorization"] = "Bearer #{request.api_key}"
          h["user-agent"] = request.user_agent || "claude-cli/2.1.75 (external, cli)"
          h["x-app"] = "cli"
        else
          h["x-api-key"] = request.api_key.to_s
        end
        beta = beta_headers
        h["anthropic-beta"] = beta.join(",") unless beta.empty?
        h.merge!(request.default_headers.to_h { |k, v| [k.to_s, v.to_s] }) if request.default_headers
        h
      end

      def beta_headers
        betas = []
        betas.push("claude-code-20250219", "oauth-2025-04-20") if @oauth
        betas << "compact-2026-01-12" if request.compaction
        betas << "context-management-2025-06-27" if request.clear_tool_uses
        betas << "fine-grained-tool-streaming-2025-05-14"
        betas << "interleaved-thinking-2025-05-14" unless Transform.adaptive_thinking_model?(request.model)
        betas
      end

      def build_body
        cache_control = Transform.to_anthropic_cache_control(request.cache_retention, request.base_url)
        downgraded = Transform.downgrade_unsupported_images(request.messages, request.supports_images)
        downgraded = Transform.downgrade_unsupported_videos(downgraded, request.supports_video)
        converted = Transform.to_anthropic_messages(downgraded, cache_control: cache_control)
        system = converted[:system]
        if @oauth
          system = [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
                    *(system || [])]
        end

        max_tokens = request.max_tokens || 4096
        thinking = nil
        output_config = nil
        if request.thinking
          t = Transform.to_anthropic_thinking(request.thinking, max_tokens, request.model)
          thinking = t[:thinking]
          max_tokens = t[:max_tokens]
          output_config = t[:output_config]
        end

        body = { model: request.model, max_tokens: max_tokens, messages: converted[:messages], stream: streaming? }
        body[:system] = system if system
        body[:thinking] = thinking if thinking
        body[:output_config] = output_config if output_config
        body[:temperature] = request.temperature if !request.temperature.nil? && thinking.nil?
        body[:top_p] = request.top_p unless request.top_p.nil?
        body[:stop_sequences] = request.stop if request.stop
        merge_tools(body, cache_control)
        if request.tool_choice && request.tools && !request.tools.empty?
          body[:tool_choice] = Transform.to_anthropic_tool_choice(request.tool_choice)
        end
        edits = []
        edits << { type: "compact_20260112" } if request.compaction
        edits << { type: "clear_tool_uses_20250919" } if request.clear_tool_uses
        body[:context_management] = { edits: edits } unless edits.empty?
        body
      end

      def merge_tools(body, cache_control)
        has_client = request.tools && !request.tools.empty?
        has_server = request.server_tools && !request.server_tools.empty?
        return unless has_client || has_server || request.web_search

        reserved = []
        reserved << "web_search" if request.web_search
        Array(request.server_tools).each { |t| reserved << (t[:name] || t["name"]) }
        client = has_client ? Transform.to_anthropic_tools(request.tools.reject { |t| reserved.include?(t.name) },
                                                           cache_control: first_party? ? cache_control : nil) : []
        tools = client + Array(request.server_tools)
        tools << { type: "web_search_20250305", name: "web_search" } if request.web_search
        body[:tools] = tools
      end

      # ── streaming ──────────────────────────────────────────
      def run_streaming(body)
        state = StreamState.new
        reader = SSE::Reader.new
        HTTP.post_stream(url: "#{base_url}#{ENDPOINT_PATH}", headers: headers,
                         body: JSON.generate(body), cancellation: cancellation) do |chunk|
          reader.push(chunk) { |frame| handle_frame(frame, state) }
        end
        reader.flush { |frame| handle_frame(frame, state) }
        finalize(state)
      end

      def handle_frame(frame, state)
        return if frame.data.nil? || frame.data.empty?

        event = JSON.parse(frame.data)
        dispatch_event(event["type"], event, state)
      rescue JSON::ParserError
        nil
      end

      def dispatch_event(type, event, state)
        case type
        when "message_start"
          usage = event.dig("message", "usage") || {}
          state.input_tokens = usage["input_tokens"].to_i
          state.cache_read = usage["cache_read_input_tokens"] if usage["cache_read_input_tokens"]
          state.cache_write = usage["cache_creation_input_tokens"] if usage["cache_creation_input_tokens"]
          emit(Event::Keepalive.new)
        when "content_block_start"
          start_block(event, state)
        when "content_block_delta"
          delta_block(event, state)
        when "content_block_stop"
          stop_block(event, state)
        when "message_delta"
          state.stop_reason = event.dig("delta", "stop_reason") if event.dig("delta", "stop_reason")
          out = event.dig("usage", "output_tokens")
          state.output_tokens = out if out
          emit(Event::Keepalive.new)
        else
          emit(Event::Keepalive.new)
        end
      end

      def start_block(event, state)
        block = event["content_block"] || {}
        accum = { type: block["type"], text: +"", thinking: +"", signature: +"",
                  tool_id: "", tool_name: "", args_json: +"", input: nil, raw: nil }
        case block["type"]
        when "tool_use"
          accum[:tool_id] = block["id"]
          accum[:tool_name] = block["name"]
          accum[:input] = block["input"]
        when "server_tool_use"
          accum[:tool_id] = block["id"]
          accum[:tool_name] = block["name"]
          accum[:input] = block["input"]
        when "redacted_thinking"
          accum[:raw] = block
        end
        state.blocks[event["index"]] = accum
        block["type"] == "thinking" ? emit(Event::ThinkingDelta.new(text: "")) : emit(Event::Keepalive.new)
      end

      def delta_block(event, state)
        accum = state.blocks[event["index"]]
        return unless accum

        delta = event["delta"] || {}
        case delta["type"]
        when "text_delta"
          accum[:text] << delta["text"].to_s
          emit(Event::TextDelta.new(text: delta["text"].to_s))
        when "thinking_delta"
          accum[:thinking] << delta["thinking"].to_s
          emit(Event::ThinkingDelta.new(text: delta["thinking"].to_s))
        when "input_json_delta"
          partial = delta["partial_json"].to_s
          accum[:args_json] << partial
          emit(Event::ToolCallDelta.new(id: accum[:tool_id], name: accum[:tool_name], args_json: partial))
        when "signature_delta"
          accum[:signature] = delta["signature"].to_s
        end
      end

      def stop_block(event, state)
        accum = state.blocks.delete(event["index"])
        return unless accum

        case accum[:type]
        when "text"
          state.content << Types.text(accum[:text])
        when "thinking"
          state.content << Types.thinking(accum[:thinking], signature: accum[:signature])
          emit(Event::Keepalive.new)
        when "tool_use"
          args = json_or(accum[:args_json], accum[:input])
          state.content << Types.tool_call(id: accum[:tool_id], name: accum[:tool_name], args: args)
          emit(Event::ToolCallDone.new(id: accum[:tool_id], name: accum[:tool_name], args: args))
        when "server_tool_use"
          input = accum[:args_json].empty? ? accum[:input] : (json_or(accum[:args_json], accum[:input]))
          state.content << { type: "server_tool_call", id: accum[:tool_id], name: accum[:tool_name], input: input }
          emit(Event::ServerToolCall.new(id: accum[:tool_id], name: accum[:tool_name], input: input))
        when "redacted_thinking"
          state.content << { type: "raw", data: accum[:raw] } if accum[:raw]
          emit(Event::Keepalive.new)
        end
      end

      def json_or(args_json, fallback)
        return fallback.is_a?(Hash) ? fallback : {} if args_json.nil? || args_json.empty?

        parsed = JSON.parse(args_json)
        parsed.is_a?(Hash) ? parsed : (fallback.is_a?(Hash) ? fallback : {})
      rescue JSON::ParserError
        fallback.is_a?(Hash) ? fallback : {}
      end

      def finalize(state)
        stop_reason = Transform.normalize_anthropic_stop_reason(state.stop_reason)
        message = { role: "assistant", content: state.content.empty? ? "" : state.content }
        emit(Event::Done.new(stop_reason: stop_reason))
        Response.new(message: message, stop_reason: stop_reason, usage: state.usage)
      end

      # ── buffered (non-streaming fallback) ──────────────────
      def run_buffered(body)
        result = HTTP.post(url: "#{base_url}#{ENDPOINT_PATH}", headers: headers,
                           body: JSON.generate(body), cancellation: cancellation)
        message = JSON.parse(result.body)
        synthesize_from_message(message)
      end

      def synthesize_from_message(message)
        content = []
        Array(message["content"]).each do |block|
          case block["type"]
          when "text"
            content << Types.text(block["text"].to_s)
            emit(Event::TextDelta.new(text: block["text"].to_s))
          when "thinking"
            content << Types.thinking(block["thinking"].to_s, signature: block["signature"])
            emit(Event::ThinkingDelta.new(text: block["thinking"].to_s)) if request.thinking
          when "tool_use"
            args = block["input"].is_a?(Hash) ? block["input"] : {}
            content << Types.tool_call(id: block["id"], name: block["name"], args: args)
            emit(Event::ToolCallDone.new(id: block["id"], name: block["name"], args: args))
          when "redacted_thinking"
            content << { type: "raw", data: block }
          end
        end
        usage_obj = message["usage"] || {}
        usage = Usage.new(
          input_tokens: usage_obj["input_tokens"].to_i, output_tokens: usage_obj["output_tokens"].to_i,
          cache_read: usage_obj["cache_read_input_tokens"].to_i, cache_write: usage_obj["cache_creation_input_tokens"].to_i
        )
        stop_reason = Transform.normalize_anthropic_stop_reason(message["stop_reason"])
        emit(Event::Done.new(stop_reason: stop_reason))
        Response.new(message: { role: "assistant", content: content.empty? ? "" : content },
                     stop_reason: stop_reason, usage: usage)
      end

      # ── errors ─────────────────────────────────────────────
      def translate_http_error(err)
        body = parse_error_body(err.body)
        message = body[:message] || "HTTP #{err.status}"
        request_id = err.headers["request-id"] || err.headers["x-request-id"]
        if err.status == 402 || Errors.hard_billing_message?(message)
          message = message.match?(/usage limit reached/i) ? message : "usage limit reached: #{message}"
          return ProviderError.new(provider_name, message, status_code: err.status, request_id: request_id)
        end
        resets_at = nil
        if err.status == 429
          retry_after = err.headers["retry-after"]&.to_f
          resets_at = (Errors.now_ms / 1000) + retry_after if retry_after&.positive?
        end
        ProviderError.new(provider_name, message, status_code: err.status,
                          request_id: request_id, resets_at: resets_at)
      end

      def parse_error_body(raw)
        parsed = JSON.parse(raw)
        err = parsed["error"] || parsed
        { message: err["message"] }
      rescue JSON::ParserError
        { message: raw.to_s[0, 500] }
      end

      # Accumulated streaming state: per-index content blocks + usage + content.
      class StreamState
        attr_accessor :input_tokens, :output_tokens, :cache_read, :cache_write, :stop_reason
        attr_reader :blocks, :content

        def initialize
          @blocks = {}
          @content = []
          @input_tokens = 0
          @output_tokens = 0
          @cache_read = nil
          @cache_write = nil
          @stop_reason = nil
        end

        def usage
          Usage.new(input_tokens: @input_tokens, output_tokens: @output_tokens,
                    cache_read: @cache_read.to_i, cache_write: @cache_write.to_i)
        end
      end
    end
  end
end
