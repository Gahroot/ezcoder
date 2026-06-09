# frozen_string_literal: true

module EZAgent
  # Final result of a Loop#run: the last assistant message, the number of turns
  # taken, and accumulated token usage across all turns. Convenience accessors
  # surface the final text and reasoning for the common "just give me the answer"
  # case. Port of AgentResult.
  Result = Data.define(:message, :total_turns, :total_usage) do
    # Concatenated text blocks of the final assistant message.
    def final_text
      content = message[:content] || message["content"]
      return content if content.is_a?(String)
      return "" unless content.is_a?(Array)

      content.select { |b| (b[:type] || b["type"]) == "text" }
             .map { |b| b[:text] || b["text"] }
             .join
    end

    # Concatenated thinking blocks of the final assistant message.
    def final_reasoning
      content = message[:content] || message["content"]
      return "" unless content.is_a?(Array)

      content.select { |b| (b[:type] || b["type"]) == "thinking" }
             .map { |b| b[:text] || b["text"] }
             .join
    end
  end
end
