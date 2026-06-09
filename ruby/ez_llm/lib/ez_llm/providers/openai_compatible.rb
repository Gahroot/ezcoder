# frozen_string_literal: true

module EZLLM
  module Providers
    # OpenAI Chat Completions transport. Covers first-party OpenAI (API-key path)
    # and every OpenAI-compatible provider: Moonshot/Kimi, GLM, MiniMax (chat
    # path), Xiaomi/MiMo, DeepSeek, OpenRouter, Qwen. Provider-specific quirks
    # (GLM/Moonshot/Xiaomi `thinking` body param, reasoning_content round-trip,
    # cache key) are honored here.
    #
    # Port of providers/openai.ts + the OpenAI-compatible entries in stream.ts.
    class OpenAICompatible < Base
      ENDPOINT_PATH = "/chat/completions"

      def run(&on_event)
        @on_event = on_event
        downgraded = Transform.downgrade_unsupported_images(request.messages, request.supports_images)
        downgraded = Transform.downgrade_unsupported_videos(downgraded, request.supports_video)
        @messages = Transform.to_openai_messages(
          downgraded, provider: provider_name, thinking: !request.thinking.nil?,
          supports_images: request.supports_images
        )
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

      def uses_thinking_param?
        %w[glm moonshot xiaomi].include?(provider_name)
      end

      def base_url
        request.base_url || "https://api.openai.com/v1"
      end

      def headers
        h = { "authorization" => "Bearer #{request.api_key}" }
        h.merge!(stringify_headers(request.default_headers)) if request.default_headers
        h
      end

      def stringify_headers(hash)
        hash.to_h { |k, v| [k.to_s, v.to_s] }
      end

      def build_body
        default_temp = provider_name == "glm" ? 0.6 : nil
        effective_temp = request.temperature || default_temp

        body = { model: request.model, messages: @messages, stream: streaming? }
        body[:max_completion_tokens] = request.max_tokens if request.max_tokens
        body[:temperature] = effective_temp if !effective_temp.nil? && request.thinking.nil?
        body[:top_p] = request.top_p unless request.top_p.nil?
        body[:stop] = request.stop if request.stop
        if request.thinking && !uses_thinking_param?
          body[:reasoning_effort] = Transform.to_openai_reasoning_effort(request.thinking, request.model)
        end
        if request.tools && !request.tools.empty?
          body[:tools] = Transform.to_openai_tools(request.tools)
          if request.tool_choice
            body[:tool_choice] = Transform.to_openai_tool_choice(request.tool_choice)
          end
        end
        body[:stream_options] = { include_usage: true } if streaming?

        # prompt_cache_key only for providers known to support it.
        if %w[openai moonshot].include?(provider_name)
          body[:prompt_cache_key] = request.prompt_cache_key || "ezllm"
          body[:prompt_cache_retention] = "24h" if (request.cache_retention || :short).to_sym == :long
        end
        body[:service_tier] = request.service_tier if provider_name == "openai" && request.service_tier

        # GLM/Moonshot/Xiaomi use an explicit { thinking: { type } } param. MiMo is
        # always-on reasoning; without { type: "disabled" } it returns thinking-only.
        if uses_thinking_param?
          body[:thinking] = { type: request.thinking ? "enabled" : "disabled" }
        end
        body
      end

      # ── streaming ──────────────────────────────────────────
      def run_streaming(body)
        acc = Accumulator.new
        reader = SSE::Reader.new
        HTTP.post_stream(url: "#{base_url}#{ENDPOINT_PATH}", headers: headers,
                         body: JSON.generate(body), cancellation: cancellation) do |chunk|
          reader.push(chunk) { |frame| handle_frame(frame, acc) }
        end
        reader.flush { |frame| handle_frame(frame, acc) }
        finalize(acc)
      end

      def handle_frame(frame, acc)
        data = frame.data
        return if data.nil? || data.empty? || data == "[DONE]"

        chunk = JSON.parse(data)
        usage = chunk["usage"]
        acc.apply_usage(extract_usage(usage)) if usage

        choice = chunk.dig("choices", 0)
        return unless choice

        acc.finish_reason = choice["finish_reason"] if choice["finish_reason"]
        delta = choice["delta"] || {}

        reasoning = delta["reasoning_content"]
        if reasoning.is_a?(String) && !reasoning.empty?
          acc.thinking << reasoning
          emit(Event::ThinkingDelta.new(text: reasoning)) if request.thinking
        end

        if (text = delta["content"]) && !text.to_s.empty?
          acc.text << text
          emit(Event::TextDelta.new(text: text))
        end

        Array(delta["tool_calls"]).each { |tc| accumulate_tool_call(tc, acc) }
      end

      def accumulate_tool_call(tool_call, acc)
        index = tool_call["index"] || 0
        entry = acc.tool_call(index)
        entry[:id] = tool_call["id"] if tool_call["id"]
        func = tool_call["function"] || {}
        entry[:name] = func["name"] if func["name"]
        args = func["arguments"]
        return if args.nil? || args.empty?

        entry[:args_json] << args
        emit(Event::ToolCallDelta.new(id: entry[:id], name: entry[:name], args_json: args))
      end

      def finalize(acc)
        content = []
        content << Types.thinking(acc.thinking) unless acc.thinking.empty?
        content << Types.text(acc.text) unless acc.text.empty?
        acc.tool_calls.each_value do |tc|
          args = parse_tool_arguments(tc[:args_json])
          content << Types.tool_call(id: tc[:id], name: tc[:name], args: args)
          emit(Event::ToolCallDone.new(id: tc[:id], name: tc[:name], args: args))
        end

        stop_reason = Transform.normalize_openai_stop_reason(acc.finish_reason)
        message = { role: "assistant", content: content.empty? ? (acc.text.empty? ? "" : acc.text) : content }
        emit(Event::Done.new(stop_reason: stop_reason))
        Response.new(message: message, stop_reason: stop_reason, usage: acc.usage)
      end

      # ── buffered (non-streaming fallback) ──────────────────
      def run_buffered(body)
        result = HTTP.post(url: "#{base_url}#{ENDPOINT_PATH}", headers: headers,
                           body: JSON.generate(body), cancellation: cancellation)
        completion = JSON.parse(result.body)
        synthesize_from_completion(completion)
      end

      def synthesize_from_completion(completion)
        choice = completion.dig("choices", 0)
        usage = completion["usage"] ? extract_usage(completion["usage"]) : Usage.new
        content = []

        if choice
          msg = choice["message"] || {}
          reasoning = msg["reasoning_content"]
          if reasoning.is_a?(String) && !reasoning.empty?
            content << Types.thinking(reasoning)
            emit(Event::ThinkingDelta.new(text: reasoning)) if request.thinking
          end
          if (text = msg["content"]).is_a?(String) && !text.empty?
            content << Types.text(text)
            emit(Event::TextDelta.new(text: text))
          end
          Array(msg["tool_calls"]).each do |tc|
            func = tc["function"] || {}
            args_json = func["arguments"] || ""
            emit(Event::ToolCallDelta.new(id: tc["id"], name: func["name"], args_json: args_json)) unless args_json.empty?
            args = parse_tool_arguments(args_json)
            content << Types.tool_call(id: tc["id"], name: func["name"], args: args)
            emit(Event::ToolCallDone.new(id: tc["id"], name: func["name"], args: args))
          end
        end

        stop_reason = Transform.normalize_openai_stop_reason(choice && choice["finish_reason"])
        message = { role: "assistant", content: content.empty? ? "" : content }
        emit(Event::Done.new(stop_reason: stop_reason))
        Response.new(message: message, stop_reason: stop_reason, usage: usage)
      end

      # ── usage ──────────────────────────────────────────────
      def extract_usage(usage)
        cache_read = 0
        details = usage["prompt_tokens_details"]
        cache_read = details["cached_tokens"] if details && details["cached_tokens"]
        cache_read = usage["cached_tokens"] if cache_read.zero? && usage["cached_tokens"].to_i.positive?
        if cache_read.zero? && usage["prompt_cache_hit_tokens"].to_i.positive?
          cache_read = usage["prompt_cache_hit_tokens"]
        end
        prompt = usage["prompt_tokens"].to_i
        Usage.new(input_tokens: prompt - cache_read, output_tokens: usage["completion_tokens"].to_i,
                  cache_read: cache_read)
      end

      # ── errors ─────────────────────────────────────────────
      def translate_http_error(err)
        body = parse_error_body(err.body)
        message = body[:message] || "HTTP #{err.status}"
        klass = classify_limit(status: err.status, code: body[:code], type: body[:type], message: message)
        if klass == :hard
          message = message.match?(/usage limit reached/i) ? message : "usage limit reached: #{message}"
          return ProviderError.new(provider_name, message, status_code: err.status, request_id: body[:request_id])
        end
        resets_at = nil
        if klass == :transient
          retry_after = err.headers["retry-after"]&.to_f
          resets_at = (Errors.now_ms / 1000) + retry_after if retry_after&.positive?
        end
        ProviderError.new(provider_name, message, status_code: err.status,
                          request_id: body[:request_id], resets_at: resets_at)
      end

      def parse_error_body(raw)
        parsed = JSON.parse(raw)
        err = parsed["error"] || parsed
        { message: err["message"], code: err["code"], type: err["type"],
          request_id: parsed["request_id"] || err["request_id"] }
      rescue JSON::ParserError
        { message: raw.to_s[0, 500] }
      end

      def classify_limit(status:, code:, type:, message:)
        code_type = "#{code} #{type}".downcase
        return :hard if status == 402 || code_type.include?("insufficient_quota") || Errors.hard_billing_message?(message)
        if status == 429 || code_type.include?("rate_limit_exceeded") || code_type.include?("too_many_requests")
          return :transient
        end

        nil
      end

      # Per-stream accumulator: text, thinking, tool calls (by index), usage.
      class Accumulator
        attr_accessor :finish_reason
        attr_reader :text, :thinking, :tool_calls, :usage

        def initialize
          @text = +""
          @thinking = +""
          @tool_calls = {}
          @usage = Usage.new
          @finish_reason = nil
        end

        def tool_call(index)
          @tool_calls[index] ||= { id: "", name: "", args_json: +"" }
        end

        def apply_usage(usage)
          @usage = usage
        end
      end
    end
  end
end
