# frozen_string_literal: true

module EZAgent
  # Tool-result truncation. Oversized results are capped before insertion into
  # message history, keeping a 70% head + 30% tail so both the start (what the
  # tool found) and end (errors/diagnostics) survive. Mirrors capToolResults /
  # truncateToolResultText from agent-loop.ts.
  module Truncation
    HARD_MAX = 400_000 # absolute ceiling regardless of context window
    TAIL_FRACTION = 0.3
    MAX_TAIL = 20_000

    module_function

    # Truncate a single string to `max_chars`, head 70% / tail 30%.
    def truncate_text(text, max_chars)
      return text if max_chars.nil? || text.length <= max_chars

      tail_chars = [(max_chars * TAIL_FRACTION).floor, MAX_TAIL].min
      head_chars = [max_chars - tail_chars, 0].max
      omitted = text.length - head_chars - tail_chars
      "#{text[0, head_chars]}\n\n[... #{omitted} characters omitted ...]\n\n#{text[-tail_chars..]}"
    end

    # Cap a tool_result's string content to min(max_chars, HARD_MAX). Returns the
    # (possibly truncated) content. Non-string content passes through untouched.
    def cap(content, max_chars)
      return content unless content.is_a?(String)
      return content if max_chars.nil?

      max = [max_chars, HARD_MAX].min
      return content if content.length <= max

      head_chars = (max * 0.7).floor
      tail_chars = max - head_chars
      omitted = content.length - head_chars - tail_chars
      "#{content[0, head_chars]}\n\n[... #{omitted} characters omitted ...]\n\n#{content[-tail_chars..]}"
    end
  end
end
