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
    #
    # For assistant messages the raw markdown text is emitted in a
    # +data-markdown-text+ attribute so the client-side initializer can render
    # it with +marked+ (syntax-highlighted code blocks, tables, etc.).
    def ez_agent_message_body(message)
      content = message.to_llm_message[:content]
      if content.is_a?(String)
        return ez_agent_markdown_container(content) if message.role == "assistant"
        return content_tag(:p, content)
      end
      return "".html_safe unless content.is_a?(Array)

      assistant = (message.role == "assistant")
      safe_join(content.map { |block| ez_agent_content_block(block, assistant: assistant) }.compact)
    end

    # @api private
    def ez_agent_content_block(block, assistant: false)
      case block[:type]
      when "text"
        if assistant
          ez_agent_markdown_container(block[:text].to_s)
        else
          content_tag(:p, block[:text].to_s)
        end
      when "thinking"
        content_tag(:p, block[:text].to_s, class: "ez-agent-delta--thinking")
      when "tool_call"
        ez_agent_tool_call_card(block)
      when "tool_result"
        ez_agent_tool_result_card(block)
      end
    end

    # @api private
    def ez_agent_compact_json(value)
      JSON.generate(value)
    rescue StandardError
      value.to_s
    end

    # Render a persisted tool_call content block as a collapsible styled card.
    # @api private
    def ez_agent_tool_call_card(block)
      name  = block[:name].to_s
      args  = block[:args]
      args_json = begin
        JSON.pretty_generate(args)
      rescue StandardError
        args.to_s
      end
      collapsed = args_json.length > 500

      tag.div(class: "ez-agent-message ez-agent-message--tool-call") do
        tag.details(class: "ez-agent-tool__card", open: !collapsed) do
          tag.summary(class: "ez-agent-tool__summary") do
            safe_join([
              tag.span(content_tag(:i, "", data: { lucide: "wrench" }), class: "ez-agent-tool__icon"),
              tag.span(name, class: "ez-agent-tool__name"),
              tag.span("invoked", class: "ez-agent-tool__badge ez-agent-tool__badge--running"),
              tag.span(class: "ez-agent-tool__chevron") { "" }
            ])
          end +
          tag.div(class: "ez-agent-tool__body") do
            tag.div(class: "ez-agent-tool__section") do
              tag.div("Parameters", class: "ez-agent-tool__section-label") +
              tag.pre(args_json, class: "ez-agent-tool__pre")
            end
          end
        end
      end
    end

    # Render a persisted tool_result content block as a collapsible styled card.
    # @api private
    def ez_agent_tool_result_card(block)
      tool_call_id = block[:tool_call_id].to_s
      is_error = block[:is_error] || false
      result_text = EZLLM::Types.tool_result_text(block[:content]).to_s

      # Split out source chips from knowledge base tool results.
      sources = extract_source_chips(result_text)
      display_text = sources ? result_text.split("--- Sources ---").first.strip : result_text
      collapsed = display_text.length > 500

      icon_name = is_error ? "circle-x" : "circle-check"
      badge_kind = is_error ? "error" : "done"
      badge_label = is_error ? "failed" : "completed"

      tag.div(class: "ez-agent-message ez-agent-message--tool-result") do
        tag.details(class: "ez-agent-tool__card", open: !collapsed) do
          tag.summary(class: "ez-agent-tool__summary") do
            safe_join([
              tag.span(content_tag(:i, "", data: { lucide: icon_name }), class: "ez-agent-tool__icon"),
              tag.span("tool result", class: "ez-agent-tool__name"),
              tag.span(badge_label, class: "ez-agent-tool__badge ez-agent-tool__badge--#{badge_kind}"),
              tag.span(class: "ez-agent-tool__chevron") { "" }
            ])
          end +
          tag.div(class: "ez-agent-tool__body") do
            tag.div(class: "ez-agent-tool__section") do
              tag.div("Output", class: "ez-agent-tool__section-label") +
              tag.pre(display_text, class: "ez-agent-tool__pre")
            end +
            (sources ? render_source_chips(sources) : "").html_safe
          end
        end
      end
    end

    # Parse the --- Sources --- JSON block appended by SearchKnowledge.
    # Returns an Array of Hashes or nil if absent.
    # @api private
    def extract_source_chips(result_text)
      return nil unless result_text.include?("--- Sources ---")
      json_str = result_text.split("--- Sources ---").last.strip
      parsed = JSON.parse(json_str)
      parsed.is_a?(Array) ? parsed : nil
    rescue JSON::ParserError, StandardError
      nil
    end

    # Render source chips from parsed source data.
    # Each source has: id, href, title, description.
    # @api private
    def render_source_chips(sources)
      return "" if sources.nil? || sources.empty?

      tag.div(class: "ez-source-chips") do
        safe_join(sources.map { |s| render_single_source_chip(source: s) })
      end
    end

    # @api private
    def render_single_source_chip(source:)
      href = source["href"].to_s
      title = source["title"].to_s
      description = source["description"].to_s

      tag.a(href: href, class: "ez-source-chip", title: description, target: "_blank", rel: "noopener") do
        safe_join([
          content_tag(:i, "", data: { lucide: "file-text" }),
          content_tag(:span, title, class: "ez-source-chip__title")
        ])
      end
    end

    # Emit a div whose +data-markdown-text+ holds raw markdown. The client-side
    # initializer reads this attribute and renders it via +marked+ + +highlight.js+.
    # @api private
    def ez_agent_markdown_container(raw_text)
      tag.div(raw_text, class: "ez-agent-md", data: { markdown_text: raw_text })
    end
  end
end
