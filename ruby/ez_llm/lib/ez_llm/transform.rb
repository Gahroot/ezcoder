# frozen_string_literal: true

module EZLLM
  # Message + tool transforms: convert the framework's neutral message/content
  # shape into each provider's wire format, and normalize stop reasons back.
  #
  # Messages/content are Hashes; this module reads keys defensively (symbol or
  # string) so callers can pass either. Port of packages/ai/src/providers/transform.ts.
  module Transform
    module_function

    # ── field access helpers ─────────────────────────────────
    def field(hash, key)
      return nil unless hash.is_a?(Hash)

      hash.fetch(key) { hash[key.to_s] }
    end

    def part_type(part) = field(part, :type)
    def msg_role(msg) = field(msg, :role)
    def msg_content(msg) = field(msg, :content)

    # ── capability downgrades ────────────────────────────────
    NON_VISION_USER_IMAGE = "(image omitted: model does not support images)"
    NON_VISION_TOOL_IMAGE = "(tool image omitted: model does not support images)"
    NON_VIDEO_USER = "(video omitted: model does not support video)"

    def strip_media(content, drop_type, placeholder)
      out = []
      last_placeholder = false
      content.each do |block|
        if part_type(block) == drop_type
          out << { type: "text", text: placeholder } unless last_placeholder
          last_placeholder = true
          next
        end
        out << block
        last_placeholder = part_type(block) == "text" && field(block, :text) == placeholder
      end
      out
    end

    def downgrade_unsupported_videos(messages, supports_video)
      return messages if supports_video == true

      messages.map do |msg|
        content = msg_content(msg)
        if msg_role(msg) == "user" && content.is_a?(Array)
          msg.merge(content: strip_media(content, "video", NON_VIDEO_USER))
        else
          msg
        end
      end
    end

    def downgrade_unsupported_images(messages, supports_images)
      return messages unless supports_images == false

      messages.map do |msg|
        content = msg_content(msg)
        if msg_role(msg) == "user" && content.is_a?(Array)
          msg.merge(content: strip_media(content, "image", NON_VISION_USER_IMAGE))
        elsif msg_role(msg) == "tool"
          msg.merge(content: content.map do |tr|
            inner = field(tr, :content)
            inner.is_a?(Array) ? tr.merge(content: strip_media(inner, "image", NON_VISION_TOOL_IMAGE)) : tr
          end)
        else
          msg
        end
      end
    end

    # ── tool_result extraction ───────────────────────────────
    def tool_result_text(content)
      return content if content.is_a?(String)

      content.select { |b| part_type(b) == "text" }.map { |b| field(b, :text) }.join("\n")
    end

    def tool_result_images(content)
      return [] unless content.is_a?(Array)

      content.select { |b| part_type(b) == "image" }
    end

    def tool_result_videos(content)
      return [] unless content.is_a?(Array)

      content.select { |b| part_type(b) == "video" }
    end

    # ── OpenAI transforms ────────────────────────────────────

    def to_openai_messages(messages, provider: nil, thinking: false, supports_images: nil)
      out = []
      id_map = {}
      merge_tool_result_text = provider.to_s == "glm"

      messages.each do |msg|
        role = msg_role(msg)
        content = msg_content(msg)
        case role
        when "system"
          out << { role: "system", content: content }
        when "user"
          if merge_tool_result_text && !out.empty? && out.last[:role] == "tool"
            user_text = content.is_a?(String) ? content : text_of(content)
            unless user_text.empty?
              out.last[:content] = "#{out.last[:content] || ""}\n\n#{user_text}"
              next
            end
          end
          out << openai_user_message(content)
        when "assistant"
          openai_assistant_message(msg, content, id_map, thinking, provider).tap { |m| out << m if m }
        when "tool"
          append_openai_tool_messages(out, content, id_map, provider, supports_images)
        end
      end
      out
    end

    def text_of(content)
      return content if content.is_a?(String)

      content.select { |p| part_type(p) == "text" }.map { |p| field(p, :text) }.join
    end

    def openai_user_message(content)
      return { role: "user", content: content } if content.is_a?(String)

      parts = content.map do |part|
        case part_type(part)
        when "text"
          { type: "text", text: field(part, :text) }
        when "video"
          file_id = field(part, :file_id)
          video_url = file_id ? { url: "ms://#{file_id}", id: file_id } : { url: data_url(part) }
          { type: "video_url", video_url: video_url }
        else
          { type: "image_url", image_url: { url: data_url(part) } }
        end
      end
      { role: "user", content: parts }
    end

    def data_url(part)
      "data:#{field(part, :media_type)};base64,#{field(part, :data)}"
    end

    def openai_assistant_message(_msg, content, id_map, thinking, provider)
      if content.is_a?(String)
        return content.empty? ? nil : { role: "assistant", content: content }
      end

      tool_calls = content.select { |p| part_type(p) == "tool_call" }.map do |tc|
        { id: remap_tool_call_id(field(tc, :id), id_map), type: "function",
          function: { name: field(tc, :name), arguments: JSON.generate(field(tc, :args) || {}) } }
      end
      text = content.select { |p| part_type(p) == "text" }.map { |p| field(p, :text) }.join
      thinking_text = content.select { |p| part_type(p) == "thinking" }.map { |p| field(p, :text) }.join

      content_value = text.empty? ? nil : text
      has_tool_calls = !tool_calls.empty?
      return nil if content_value.nil? && !has_tool_calls

      message = { role: "assistant", content: content_value }
      message[:tool_calls] = tool_calls if has_tool_calls
      if !thinking_text.empty?
        message[:reasoning_content] = thinking_text
      elsif thinking && has_tool_calls && provider.to_s != "glm"
        message[:reasoning_content] = " "
      end
      message
    end

    def append_openai_tool_messages(out, content, id_map, provider, supports_images)
      is_moonshot = provider.to_s == "moonshot"
      follow_up = []
      follow_up_has_video = false

      content.each do |result|
        inner = field(result, :content)
        text = tool_result_text(inner)
        images = tool_result_images(inner)
        videos = tool_result_videos(inner)
        call_id = remap_tool_call_id(field(result, :tool_call_id), id_map)

        if is_moonshot && !videos.empty?
          parts = []
          parts << { type: "text", text: text } unless text.empty?
          parts.concat(videos.map do |v|
            fid = field(v, :file_id)
            { type: "video_url", video_url: fid ? { url: "ms://#{fid}", id: fid } : { url: data_url(v) } }
          end)
          out << { role: "tool", tool_call_id: call_id, content: parts }
          next
        end

        out << { role: "tool", tool_call_id: call_id, content: text.empty? ? "(see attached media)" : text }

        if !images.empty? && supports_images != false
          images.each { |img| follow_up << { type: "image_url", image_url: { url: data_url(img) } } }
        end
        next if is_moonshot || videos.empty?

        videos.each do |v|
          follow_up << { type: "video_url", video_url: { url: data_url(v) } }
          follow_up_has_video = true
        end
      end

      return if follow_up.empty?

      label = follow_up_has_video ? "Attached media from tool result:" : "Attached image(s) from tool result:"
      out << { role: "user", content: [{ type: "text", text: label }, *follow_up] }
    end

    def to_openai_tools(tools)
      tools.map do |tool|
        { type: "function",
          function: { name: tool.name, description: tool.description,
                      parameters: tool.input_schema } }
      end
    end

    def to_openai_tool_choice(choice)
      case choice
      when "auto", :auto then "auto"
      when "none", :none then "none"
      when "required", :required then "required"
      else
        name = choice.is_a?(Hash) ? (choice[:name] || choice["name"]) : choice
        { type: "function", function: { name: name } }
      end
    end

    def to_openai_reasoning_effort(level, _model = nil)
      level.to_sym == :max ? "xhigh" : level.to_s
    end

    def normalize_openai_stop_reason(reason)
      case reason
      when "tool_calls" then "tool_use"
      when "length" then "max_tokens"
      when "stop" then "stop_sequence"
      else "end_turn"
      end
    end

    # Remap Anthropic toolu_* ids → call_* so OpenAI accepts them; pass others through.
    def remap_tool_call_id(id, id_map)
      return id unless id.is_a?(String) && id.start_with?("toolu_")
      return id_map[id] if id_map[id]

      mapped = "call_#{id[6..]}"
      id_map[id] = mapped
      mapped
    end

    # Anthropic requires tool_use ids to match ^[A-Za-z0-9_-]+$. Sanitize any
    # disallowed characters (Codex composite ids, dots/colons) and memoize so the
    # tool_use id still matches its tool_result.tool_use_id.
    def remap_anthropic_tool_call_id(id, id_map)
      return id if id.is_a?(String) && id.match?(/\A[a-zA-Z0-9_-]+\z/)
      return id_map[id] if id_map[id]

      mapped = id.to_s.gsub(/[^a-zA-Z0-9_-]/, "_")
      id_map[id] = mapped
      mapped
    end

    # ── Anthropic transforms ─────────────────────────────────

    def normalize_anthropic_stop_reason(reason)
      case reason
      when "tool_use" then "tool_use"
      when "max_tokens" then "max_tokens"
      when "pause_turn" then "pause_turn"
      when "stop_sequence" then "stop_sequence"
      when "refusal" then "refusal"
      else "end_turn"
      end
    end

    def to_anthropic_cache_control(retention, base_url)
      resolved = (retention || :short).to_sym
      return nil if resolved == :none

      first_party = base_url.nil? || base_url.include?("api.anthropic.com")
      cc = { type: "ephemeral" }
      cc[:ttl] = "1h" if resolved == :long && first_party
      cc
    end

    def adaptive_thinking_model?(model)
      /opus-4[-.]8|opus-4[-.]7|opus-4[-.]6|sonnet-4[-.]6/.match?(model)
    end

    def to_anthropic_thinking(level, max_tokens, model)
      level = level.to_sym
      if adaptive_thinking_model?(model)
        effort = level.to_s
        effort = "high" if effort == "xhigh" && !/opus-4-8|opus-4-7/.match?(model)
        return { thinking: { type: "adaptive" }, max_tokens: max_tokens, output_config: { effort: effort } }
      end

      effective = %i[xhigh max].include?(level) ? :high : level
      budget = {
        low: [1024, (max_tokens * 0.25).floor].max,
        medium: [2048, (max_tokens * 0.5).floor].max,
        high: [4096, max_tokens].max
      }.fetch(effective)
      { thinking: { type: "enabled", budget_tokens: budget }, max_tokens: max_tokens + budget }
    end

    def to_anthropic_tool_choice(choice)
      case choice
      when "auto", :auto then { type: "auto" }
      when "none", :none then { type: "none" }
      when "required", :required then { type: "any" }
      else
        name = choice.is_a?(Hash) ? (choice[:name] || choice["name"]) : choice
        { type: "tool", name: name }
      end
    end

    def to_anthropic_tools(tools, cache_control: nil)
      tools.each_with_index.map do |tool, index|
        entry = { name: tool.name, description: tool.description, input_schema: tool.input_schema }
        entry[:cache_control] = cache_control if cache_control && index == tools.length - 1
        entry
      end
    end

    # Returns { system:, messages: } in Anthropic wire shape.
    def to_anthropic_messages(messages, cache_control: nil)
      system_text = nil
      out = []
      id_map = {}
      trajectory_start = messages.each_index.select { |i| msg_role(messages[i]) == "user" }.last || -1

      messages.each_with_index do |msg, idx|
        role = msg_role(msg)
        content = msg_content(msg)
        case role
        when "system"
          system_text = content
        when "user"
          out << { role: "user", content: anthropic_user_content(content) }
        when "assistant"
          blocks = content.is_a?(String) ? content : anthropic_assistant_content(content, idx > trajectory_start, id_map)
          next if blocks.is_a?(Array) && blocks.empty?

          out << { role: "assistant", content: blocks }
        when "tool"
          out << { role: "user", content: content.map do |result|
            { type: "tool_result",
              tool_use_id: remap_anthropic_tool_call_id(field(result, :tool_call_id), id_map),
              content: anthropic_tool_result_content(field(result, :content)),
              is_error: field(result, :is_error) }
          end }
        end
      end

      apply_anthropic_cache_control(out, cache_control) if cache_control
      { system: anthropic_system(system_text, cache_control), messages: out }
    end

    def anthropic_user_content(content)
      return content if content.is_a?(String)

      content.map do |part|
        case part_type(part)
        when "text"
          { type: "text", text: field(part, :text) }
        when "video"
          { type: "video", source: { type: "base64", media_type: field(part, :media_type), data: field(part, :data) } }
        else
          { type: "image", source: { type: "base64", media_type: field(part, :media_type), data: field(part, :data) } }
        end
      end
    end

    def anthropic_assistant_content(content, preserve_thinking, id_map)
      parts =
        if preserve_thinking
          last_thinking = content.each_index.select { |i| position_sensitive_thinking?(content[i]) }.last || -1
          content.each_with_index.reject do |part, idx|
            (part_type(part) == "thinking" && !valid_thinking_signature?(part) && blank?(field(part, :text))) ||
              (part_type(part) == "text" && blank?(field(part, :text)) && idx > last_thinking)
          end.map { |part, _| part }
        else
          content.reject do |part|
            part_type(part) == "thinking" || raw_thinking?(part) ||
              (part_type(part) == "text" && blank?(field(part, :text)))
          end
        end
      parts.map { |part| anthropic_assistant_part(part, id_map) }.compact
    end

    def anthropic_assistant_part(part, id_map)
      case part_type(part)
      when "text"
        { type: "text", text: field(part, :text) }
      when "thinking"
        sig = field(part, :signature)
        if sig && !sig.strip.empty?
          { type: "thinking", thinking: field(part, :text), signature: sig }
        else
          { type: "text", text: field(part, :text) }
        end
      when "tool_call"
        { type: "tool_use", id: remap_anthropic_tool_call_id(field(part, :id), id_map),
          name: field(part, :name), input: field(part, :args) }
      when "server_tool_call"
        { type: "server_tool_use", id: field(part, :id), name: field(part, :name), input: field(part, :input) }
      when "server_tool_result", "raw"
        field(part, :data)
      end
    end

    def anthropic_tool_result_content(content)
      return content if content.is_a?(String)

      content.map do |block|
        case part_type(block)
        when "text"
          { type: "text", text: field(block, :text) }
        when "image"
          { type: "image", source: { type: "base64", media_type: field(block, :media_type), data: field(block, :data) } }
        when "video"
          { type: "video", source: { type: "base64", media_type: field(block, :media_type), data: field(block, :data) } }
        end
      end.compact
    end

    def anthropic_system(system_text, cache_control)
      return nil unless system_text

      marker = "<!-- uncached -->"
      idx = system_text.index(marker)
      if idx && cache_control
        cached = system_text[0...idx].rstrip
        uncached = system_text[(idx + marker.length)..].lstrip
        blocks = [{ type: "text", text: cached, cache_control: cache_control }]
        blocks << { type: "text", text: uncached } unless uncached.empty?
        blocks
      else
        block = { type: "text", text: system_text }
        block[:cache_control] = cache_control if cache_control
        [block]
      end
    end

    def apply_anthropic_cache_control(out, cache_control)
      (out.length - 1).downto(0) do |i|
        next unless out[i][:role] == "user"

        content = out[i][:content]
        if content.is_a?(String)
          out[i] = { role: "user", content: [{ type: "text", text: content, cache_control: cache_control }] }
        elsif content.is_a?(Array) && !content.empty?
          content[-1] = content[-1].merge(cache_control: cache_control)
        end
        break
      end
    end

    def position_sensitive_thinking?(part)
      return valid_thinking_signature?(part) if part_type(part) == "thinking"

      raw_thinking?(part)
    end

    def raw_thinking?(part)
      return false unless part_type(part) == "raw"

      t = field(field(part, :data) || {}, :type)
      t == "thinking" || t == "redacted_thinking"
    end

    def valid_thinking_signature?(part)
      sig = field(part, :signature)
      sig.is_a?(String) && !sig.strip.empty?
    end

    def blank?(str)
      str.nil? || str.to_s.empty?
    end
  end
end
