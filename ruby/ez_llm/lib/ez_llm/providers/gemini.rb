# frozen_string_literal: true

require "securerandom"

module EZLLM
  module Providers
    # Google Gemini transport over the public Generative Language API
    # (generativelanguage.googleapis.com), keyed per call. Builds the
    # contents/systemInstruction/tools/generationConfig request, drives the
    # `:streamGenerateContent?alt=sse` stream, and maps parts (text/thought/
    # functionCall) + usageMetadata back to framework events.
    #
    # Port of providers/gemini.ts (adapted to the API-key transport instead of
    # the Code Assist OAuth transport, for per-tenant credentials).
    class Gemini < Base
      DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
      SYNTHETIC_THOUGHT_SIGNATURE = "ezllm-thought"

      def run(&on_event)
        @on_event = on_event
        @tool_index = 0
        downgraded = Transform.downgrade_unsupported_images(request.messages, request.supports_images)
        downgraded = Transform.downgrade_unsupported_videos(downgraded, request.supports_video)
        body = build_body(downgraded)
        streaming? ? run_streaming(body) : run_buffered(body)
      rescue HTTP::HTTPError => e
        raise translate_http_error(e)
      rescue EZLLM::Error
        raise
      rescue StandardError => e
        raise ProviderError.new("gemini", e.message, cause: e)
      end

      private

      def base_url
        request.base_url || DEFAULT_BASE_URL
      end

      def headers
        { "content-type" => "application/json", "x-goog-api-key" => request.api_key.to_s }
      end

      def endpoint(method, sse:)
        url = "#{base_url}/models/#{request.model}:#{method}"
        url += "?alt=sse" if sse
        url
      end

      def build_body(messages)
        converted = to_system_and_contents(messages)
        body = { contents: converted[:contents] }
        body[:systemInstruction] = converted[:system_instruction] if converted[:system_instruction]
        if request.tools && !request.tools.empty?
          body[:tools] = [{ functionDeclarations: request.tools.map do |tool|
            { name: tool.name, description: tool.description, parameters: sanitize_schema(tool.input_schema) }
          end }]
          tc = tool_config
          body[:toolConfig] = tc if tc
        end
        gen = generation_config
        body[:generationConfig] = gen unless gen.empty?
        body[:session_id] = request.prompt_cache_key if request.prompt_cache_key
        body
      end

      def generation_config
        gen = {}
        gen[:maxOutputTokens] = request.max_tokens if request.max_tokens
        gen[:temperature] = request.temperature if !request.temperature.nil? && request.thinking.nil?
        gen[:topP] = request.top_p unless request.top_p.nil?
        gen[:stopSequences] = request.stop if request.stop
        if request.thinking
          gen[:thinkingConfig] = if gemini3?
                                   { includeThoughts: true, thinkingLevel: gemini3_level(request.thinking) }
                                 else
                                   { includeThoughts: true, thinkingBudget: thinking_budget(request.thinking) }
                                 end
        end
        gen
      end

      def gemini3?
        /\Agemini-3(?:\.|-|\z)/.match?(request.model)
      end

      def gemini3_level(level)
        level.to_sym == :low ? "LOW" : "HIGH"
      end

      def thinking_budget(level)
        { low: 4096, medium: 8192, high: 24_576, xhigh: 24_576, max: 24_576 }.fetch(level.to_sym, 8192)
      end

      def tool_config
        return nil unless request.tool_choice

        case request.tool_choice
        when "auto", :auto then { functionCallingConfig: { mode: "AUTO" } }
        when "none", :none then { functionCallingConfig: { mode: "NONE" } }
        when "required", :required then { functionCallingConfig: { mode: "ANY" } }
        else
          name = request.tool_choice.is_a?(Hash) ? (request.tool_choice[:name] || request.tool_choice["name"]) : request.tool_choice
          { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [name] } }
        end
      end

      def sanitize_schema(schema)
        strip_unsupported(deep_dup(schema))
      end

      def deep_dup(value)
        case value
        when Hash then value.to_h { |k, v| [k, deep_dup(v)] }
        when Array then value.map { |v| deep_dup(v) }
        else value
        end
      end

      def strip_unsupported(value)
        if value.is_a?(Hash)
          value.delete("$schema")
          value.delete("additionalProperties")
          value.each_value { |v| strip_unsupported(v) }
        elsif value.is_a?(Array)
          value.each { |v| strip_unsupported(v) }
        end
        value
      end

      def to_system_and_contents(messages)
        system_text = +""
        contents = []
        tool_names_by_id = {}

        messages.each do |msg|
          role = Transform.msg_role(msg)
          content = Transform.msg_content(msg)
          case role
          when "system"
            system_text << (system_text.empty? ? content.to_s : "\n\n#{content}")
          when "user"
            contents << { role: "user", parts: gemini_user_parts(content) }
          when "assistant"
            parts = gemini_assistant_parts(content, tool_names_by_id)
            contents << { role: "model", parts: parts } unless parts.empty?
          when "tool"
            parts = gemini_tool_parts(content, tool_names_by_id)
            contents << { role: "user", parts: parts } unless parts.empty?
          end
        end

        out = { contents: contents }
        out[:system_instruction] = { parts: [{ text: system_text }] } unless system_text.empty?
        out
      end

      def gemini_user_parts(content)
        return [{ text: content }] if content.is_a?(String)

        content.map do |part|
          if Transform.part_type(part) == "text"
            { text: Transform.field(part, :text) }
          else
            { inlineData: { mimeType: Transform.field(part, :media_type), data: Transform.field(part, :data) } }
          end
        end
      end

      def gemini_assistant_parts(content, tool_names_by_id)
        return content.empty? ? [] : [{ text: content }] if content.is_a?(String)

        parts = []
        content.each do |part|
          case Transform.part_type(part)
          when "text", "thinking"
            text = Transform.field(part, :text)
            parts << { text: text } if text && !text.empty?
          when "tool_call"
            id = Transform.field(part, :id)
            name = Transform.field(part, :name)
            tool_names_by_id[id] = name
            parts << { functionCall: { id: id, name: name, args: Transform.field(part, :args) },
                       thoughtSignature: SYNTHETIC_THOUGHT_SIGNATURE }
          end
        end
        parts
      end

      def gemini_tool_parts(content, tool_names_by_id)
        parts = []
        content.each do |result|
          call_id = Transform.field(result, :tool_call_id)
          name = tool_names_by_id[call_id] || call_id
          inner = Transform.field(result, :content)
          text = inner.is_a?(String) ? inner : stringify_tool_content(inner)
          response = { content: text }
          response[:isError] = true if Transform.field(result, :is_error)
          parts << { functionResponse: { id: call_id, name: name, response: response } }
          next if inner.is_a?(String)

          inner.each do |block|
            next unless Transform.part_type(block) == "video"

            parts << { inlineData: { mimeType: Transform.field(block, :media_type), data: Transform.field(block, :data) } }
          end
        end
        parts
      end

      def stringify_tool_content(content)
        content.map do |part|
          Transform.part_type(part) == "text" ? Transform.field(part, :text) : "[image #{Transform.field(part, :media_type)}]"
        end.join("\n")
      end

      # ── streaming ──────────────────────────────────────────
      def run_streaming(body)
        state = State.new
        reader = SSE::Reader.new
        HTTP.post_stream(url: endpoint("streamGenerateContent", sse: true), headers: headers,
                         body: JSON.generate(body), cancellation: cancellation) do |chunk|
          reader.push(chunk) { |frame| handle_chunk(frame.data, state) }
        end
        reader.flush { |frame| handle_chunk(frame.data, state) }
        finalize(state)
      end

      def run_buffered(body)
        result = HTTP.post(url: endpoint("generateContent", sse: false), headers: headers,
                           body: JSON.generate(body), cancellation: cancellation)
        state = State.new
        handle_chunk(result.body, state)
        finalize(state)
      end

      def handle_chunk(data, state)
        return if data.nil? || data.empty? || data == "[DONE]"

        chunk = JSON.parse(data)
        usage = chunk.dig("response", "usageMetadata") || chunk["usageMetadata"]
        if usage
          state.input_tokens = usage["promptTokenCount"] || state.input_tokens
          state.output_tokens = usage["candidatesTokenCount"] || state.output_tokens
          state.cache_read = usage["cachedContentTokenCount"] || state.cache_read
        end
        candidates = chunk.dig("response", "candidates") || chunk["candidates"]
        candidate = candidates&.first
        return unless candidate

        reason = candidate["finishReason"]
        state.stop_reason = normalize_stop_reason(reason) if reason
        Array(candidate.dig("content", "parts")).each { |part| handle_part(part, state) }
      rescue JSON::ParserError
        nil
      end

      def handle_part(part, state)
        if part.key?("text")
          text = part["text"].to_s
          if part["thought"] == true
            state.thinking << text
            emit(Event::ThinkingDelta.new(text: text))
          else
            state.text << text
            emit(Event::TextDelta.new(text: text))
          end
          return
        end

        fc = part["functionCall"]
        return unless fc

        id = fc["id"] || "gemini_call_#{@tool_index}_#{SecureRandom.hex(8)}"
        @tool_index += 1
        args = fc["args"].is_a?(Hash) ? fc["args"] : {}
        state.tool_calls << { id: id, name: fc["name"], args: args }
        emit(Event::ToolCallDelta.new(id: id, name: fc["name"], args_json: JSON.generate(args)))
      end

      def finalize(state)
        content = []
        content << Types.thinking(state.thinking) unless state.thinking.empty?
        content << Types.text(state.text) unless state.text.empty?
        state.tool_calls.each do |tc|
          content << Types.tool_call(id: tc[:id], name: tc[:name], args: tc[:args])
          emit(Event::ToolCallDone.new(id: tc[:id], name: tc[:name], args: tc[:args]))
        end
        stop_reason = state.tool_calls.empty? ? state.stop_reason : "tool_use"
        input_tokens = [0, state.input_tokens - state.cache_read].max
        usage = Usage.new(input_tokens: input_tokens, output_tokens: state.output_tokens, cache_read: state.cache_read)
        message = { role: "assistant", content: content.empty? ? "" : content }
        emit(Event::Done.new(stop_reason: stop_reason))
        Response.new(message: message, stop_reason: stop_reason, usage: usage)
      end

      def normalize_stop_reason(reason)
        case reason
        when "MAX_TOKENS" then "max_tokens"
        when "STOP" then "stop_sequence"
        when "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII" then "refusal"
        else "end_turn"
        end
      end

      def translate_http_error(err)
        message = parse_error_message(err.body)
        if err.status == 429 && (message.downcase.include?("resource_exhausted") || message.downcase.include?("quota"))
          retry_delay = parse_retry_delay(err.body)
          if retry_delay
            return ProviderError.new("gemini", message, status_code: err.status,
                                     resets_at: (Errors.now_ms / 1000) + retry_delay.ceil)
          end

          return ProviderError.new("gemini", "Gemini quota exhausted — usage limit reached. #{message}",
                                   status_code: err.status)
        end
        ProviderError.new("gemini", message, status_code: err.status)
      end

      def parse_error_message(raw)
        parsed = JSON.parse(raw)
        parsed.dig("error", "message") || raw.to_s[0, 500]
      rescue JSON::ParserError
        raw.to_s[0, 500]
      end

      def parse_retry_delay(raw)
        match = raw.to_s.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/)
        match && match[1].to_f
      end

      State = Struct.new(:text, :thinking, :tool_calls, :input_tokens, :output_tokens, :cache_read, :stop_reason) do
        def initialize
          super(+"", +"", [], 0, 0, 0, "end_turn")
        end
      end
    end
  end
end
