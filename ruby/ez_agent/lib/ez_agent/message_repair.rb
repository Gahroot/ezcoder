# frozen_string_literal: true

module EZAgent
  # In-place message-history repairs the loop runs before/around LLM calls to
  # keep provider request bodies valid: tool_use/tool_result pairing, orphaned
  # server-tool sanitation, thinking-block stripping, and oversized tool-result
  # truncation on overflow. Mirrors the repair functions in agent-loop.ts.
  module MessageRepair
    module_function

    def role(msg) = msg[:role] || msg["role"]
    def content(msg) = msg[:content] || msg["content"]
    def ptype(part) = part[:type] || part["type"]

    # Ensure every assistant message with tool_call blocks is immediately
    # followed by a tool message with matching tool_result entries; strip
    # tool_results whose tool_call has no match. Repairs in place.
    def repair_tool_pairing!(messages)
      i = 0
      while i < messages.length
        msg = messages[i]
        if role(msg) == "assistant" && content(msg).is_a?(Array)
          tool_call_ids = content(msg).select { |p| ptype(p) == "tool_call" }.map { |p| p[:id] || p["id"] }
          if tool_call_ids.any?
            nxt = messages[i + 1]
            if nxt && role(nxt) == "tool" && content(nxt).is_a?(Array)
              existing = content(nxt).map { |r| r[:tool_call_id] || r["tool_call_id"] }
              (tool_call_ids - existing).each do |id|
                content(nxt) << interrupted_result(id)
              end
            else
              messages.insert(i + 1, { role: "tool", content: tool_call_ids.map { |id| interrupted_result(id) } })
            end
          end
        end
        i += 1
      end

      # Reverse repair: drop tool_result entries with no matching tool_call.
      seen_ids = []
      i = 0
      while i < messages.length
        msg = messages[i]
        if role(msg) == "assistant" && content(msg).is_a?(Array)
          content(msg).each { |p| seen_ids << (p[:id] || p["id"]) if ptype(p) == "tool_call" }
        end
        if role(msg) == "tool" && content(msg).is_a?(Array)
          filtered = content(msg).select { |r| seen_ids.include?(r[:tool_call_id] || r["tool_call_id"]) }
          if filtered.empty?
            messages.delete_at(i)
            i -= 1
          elsif filtered.length < content(msg).length
            msg[:content] = filtered
          end
        end
        i += 1
      end
    end

    def interrupted_result(id)
      { type: "tool_result", tool_call_id: id, content: "Tool execution was interrupted.", is_error: true }
    end

    # Strip thinking / redacted_thinking content from every assistant message,
    # preserving reasoning text as plain text blocks. Last-resort recovery for a
    # thinking-block integrity 400.
    def strip_thinking_blocks!(messages)
      messages.each do |msg|
        next unless role(msg) == "assistant" && content(msg).is_a?(Array)

        next_content = []
        content(msg).each do |part|
          case ptype(part)
          when "thinking"
            text = part[:text] || part["text"]
            next_content << { type: "text", text: text } if text && !text.empty?
          when "raw"
            data = part[:data] || part["data"] || {}
            t = data[:type] || data["type"]
            next if t == "thinking" || t == "redacted_thinking"

            next_content << part
          else
            next_content << part
          end
        end
        msg[:content] = next_content
      end
    end

    # Truncate oversized string tool-results in place. Returns true if anything
    # changed. Used by the overflow-recovery path.
    def truncate_oversized_tool_results!(messages, max_chars)
      return false if max_chars <= 0

      changed = false
      messages.each do |msg|
        next unless role(msg) == "tool" && content(msg).is_a?(Array)

        content(msg).each do |result|
          rc = result[:content] || result["content"]
          next unless rc.is_a?(String)

          truncated = Truncation.truncate_text(rc, max_chars)
          if truncated != rc
            result[:content] = truncated
            changed = true
          end
        end
      end
      changed
    end
  end
end
