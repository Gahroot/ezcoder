# frozen_string_literal: true

module EZAgentRails
  # View helpers for the bundled demo chat UI. Renders a persisted {Message}'s
  # content (a String or an Array of framework content blocks) as readable HTML:
  # plain text for text/thinking blocks, a compact one-liner for tool calls, and
  # the tool output for tool results.
  module ConversationsHelper
    # Render a message body. Reads the symbol-keyed framework shape via
    # {Message#to_llm_message} so both String and content-block-Array content
    # render the same way regardless of how the JSON column round-tripped.
    def ez_agent_message_body(message)
      content = message.to_llm_message[:content]
      return content_tag(:p, content) if content.is_a?(String)
      return "".html_safe unless content.is_a?(Array)

      safe_join(content.map { |block| ez_agent_content_block(block) }.compact)
    end

    # @api private
    def ez_agent_content_block(block)
      case block[:type]
      when "text"
        content_tag(:p, block[:text].to_s)
      when "thinking"
        content_tag(:p, block[:text].to_s, class: "ez-agent-delta--thinking")
      when "tool_call"
        content_tag(:div, "🔧 #{block[:name]}(#{ez_agent_compact_json(block[:args])})",
                    class: "ez-agent-tool-line")
      when "tool_result"
        content_tag(:div, "→ #{EZLLM::Types.tool_result_text(block[:content])}",
                    class: "ez-agent-tool-line")
      end
    end

    # @api private
    def ez_agent_compact_json(value)
      JSON.generate(value)
    rescue StandardError
      value.to_s
    end
  end
end
