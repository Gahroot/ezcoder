# frozen_string_literal: true

module EZLLM
  # Content blocks, message helpers, and capability probes.
  #
  # Messages and content parts are plain Ruby Hashes with symbol keys and string
  # `role`/`type` values — mirroring the TS object literals so provider request
  # bodies build with minimal friction and everything stays JSON-serializable.
  #
  #   { role: "user", content: "hi" }
  #   { role: "user", content: [ Types.text("hi"), Types.image(media_type:, data:) ] }
  #   { role: "assistant", content: [ { type: "tool_call", id:, name:, args: } ] }
  #   { role: "tool", content: [ { type: "tool_result", tool_call_id:, content:, is_error: } ] }
  #
  # Port of the content/message types in packages/ai/src/types.ts.
  module Types
    PROVIDERS = %i[
      anthropic xiaomi openai gemini glm moonshot minimax deepseek openrouter
    ].freeze

    THINKING_LEVELS = %i[low medium high xhigh max].freeze
    CACHE_RETENTIONS = %i[none short long].freeze

    module_function

    # ── Content block constructors ───────────────────────────

    def text(value)
      { type: "text", text: value }
    end

    def thinking(value, signature: nil)
      block = { type: "thinking", text: value }
      block[:signature] = signature if signature
      block
    end

    def image(media_type:, data:)
      { type: "image", media_type: media_type, data: data }
    end

    def video(media_type:, data:, file_id: nil)
      block = { type: "video", media_type: media_type, data: data }
      block[:file_id] = file_id if file_id
      block
    end

    def tool_call(id:, name:, args:)
      { type: "tool_call", id: id, name: name, args: args }
    end

    def tool_result(tool_call_id:, content:, is_error: nil)
      block = { type: "tool_result", tool_call_id: tool_call_id, content: content }
      block[:is_error] = is_error unless is_error.nil?
      block
    end

    # ── Probes ───────────────────────────────────────────────

    # True if any message carries a video block, in user content or a tool result.
    def messages_contain_video?(messages)
      messages.any? do |msg|
        content = msg[:content] || msg["content"]
        next false unless content.is_a?(Array)

        content.any? do |part|
          ptype = part[:type] || part["type"]
          next true if ptype == "video"

          if ptype == "tool_result"
            inner = part[:content] || part["content"]
            inner.is_a?(Array) && inner.any? { |b| (b[:type] || b["type"]) == "video" }
          else
            false
          end
        end
      end
    end

    # Concatenated text from tool_result content (array or string).
    def tool_result_text(content)
      return content if content.is_a?(String)

      content.select { |b| (b[:type] || b["type"]) == "text" }
             .map { |b| b[:text] || b["text"] }
             .join("\n")
    end
  end
end
