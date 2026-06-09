# frozen_string_literal: true

module EZAgentRails
  # Event sink for a single {Run}. Pass `method(:call)` (or the instance itself,
  # which is callable) as the block to {EZAgent::Loop#run} and every
  # {EZAgent::Event} the loop yields is fanned out to two transports:
  #
  #   1. Hotwire/Turbo (PRIMARY) — two Turbo Stream channels:
  #      a) Conversation-level: text/thinking deltas and the user prompt are
  #         broadcast to `turbo_stream_from conversation`, appending into the
  #         messages area in real time.
  #      b) Run-level: tool calls, status updates, and confirmation prompts are
  #         broadcast to `turbo_stream_from run`, which lives in the active-run
  #         turbo frame. On agent_done the streaming placeholder in the messages
  #         area is replaced with the persisted assistant message.
  #
  #   2. Action Cable JSON (FALLBACK) — the same event as a structured Hash
  #      (see {EventPayload}) on {RunChannel.stream_name_for}, for non-Hotwire
  #      consumers.
  #
  # The instance is stateful for the duration of one run: it remembers each tool
  # call's name so the "ended" frame can label itself, since {EZAgent::Event}'s
  # tool_call_end carries no name.
  class Broadcaster
    PARTIAL_ROOT = "ez_agent_rails/runs"

    # @param run [EZAgentRails::Run]
    def initialize(run)
      @run = run
      @tool_names = {}
    end

    # Fan one event out to both transports. Unknown event types still get the
    # JSON broadcast (so nothing is silently dropped) but render no HTML.
    #
    # @param event [EZAgent::Event::*]
    # @return [void]
    def call(event)
      render_html(event)
      broadcast_json(event)
      nil
    end

    # Lets the instance be handed straight to the loop as the `&block`:
    # `agent.run(...) { ... }` or `agent.run(..., &broadcaster)`.
    def to_proc
      method(:call).to_proc
    end

    # Surface a pending {ToolConfirmation} as an actionable confirm card
    # (Approve / Deny / Always buttons) appended into the run's tools container.
    # Called by {EZAgentRails::RailsApprovalGate} the moment it parks a decision,
    # so the browser can resolve it while the job blocks.
    #
    # @param confirmation [EZAgentRails::ToolConfirmation]
    # @return [void]
    def confirm_request(confirmation)
      Turbo::StreamsChannel.broadcast_append_to(
        @run,
        target: DomTargets.tools(@run),
        partial: "#{PARTIAL_ROOT}/tool_confirmation",
        locals: confirmation_locals(confirmation)
      )
      nil
    end

    # Replace a confirm card in place once the user records a decision, so the
    # buttons disappear and the recorded verdict shows. Called by
    # {EZAgentRails::ToolConfirmationsController#update}.
    #
    # @param confirmation [EZAgentRails::ToolConfirmation]
    # @return [void]
    def confirm_resolved(confirmation)
      Turbo::StreamsChannel.broadcast_replace_to(
        @run,
        target: DomTargets.confirmation_frame(@run, confirmation.id),
        partial: "#{PARTIAL_ROOT}/tool_confirmation",
        locals: confirmation_locals(confirmation)
      )
      nil
    end

    # Replace the status line to reflect a stopped run. Called by {RunJob} after a
    # cooperative cancellation unwinds the loop.
    #
    # @return [void]
    def run_aborted
      status(:aborted, "Run stopped.")
      nil
    end

    # Swap the action button area from Stop → Regenerate (or vice-versa).
    # Called by {RunJob} in its `ensure` block so the UI always reflects the
    # run's final state regardless of how it ended.
    #
    # @return [void]
    def run_finished
      actions
      nil
    end

    # Broadcast the user's prompt into the conversation's messages area so it
    # appears immediately before streaming begins. Removes the empty-state
    # placeholder when the conversation was previously blank.
    #
    # Uses `html:` rather than `partial:` because the _message partial calls
    # view helpers (ez_agent_message_body) that are not in scope for
    # Turbo::StreamsChannel's default renderer. For a user message the HTML is
    # simple enough to construct inline.
    #
    # @param message [EZAgentRails::Message]
    # @return [void]
    def user_message(message)
      conversation = @run.conversation
      target_id = DomTargets.messages(conversation)

      # Remove the empty-state placeholder if present.
      Turbo::StreamsChannel.broadcast_action_to(
        conversation,
        action: "replace",
        target: "#{target_id}_empty",
        html: ""
      )

      # Append the rendered user message into the messages area.
      Turbo::StreamsChannel.broadcast_append_to(
        conversation,
        target: target_id,
        html: render_user_message_html(message)
      )
      nil
    end

    private

    def confirmation_locals(confirmation)
      {
        frame_id: DomTargets.confirmation_frame(@run, confirmation.id),
        confirmation: confirmation
      }
    end

    def render_html(event)
      case event.type
      when :text_delta     then append_text(event.text, :text_delta)
      when :thinking_delta then append_text(event.text, :thinking_delta)
      when :tool_call_start then tool_call_start(event)
      when :tool_call_end   then tool_call_end(event)
      when :retry           then status(:retry, retry_message(event))
      when :error           then status(:error, EventPayload.error_message(event.error))
      when :agent_done
        status(:done, done_message(event))
        streaming_done
      end
    end

    # ── Turbo (HTML) transport ─────────────────────────────

    # Append a text / thinking delta into the conversation's messages area via
    # the conversation-level Turbo Stream. This is the PRIMARY display path —
    # streamed text appears inline with persisted messages so the user sees a
    # coherent chat thread. The per-run stream target (DomTargets.stream) still
    # receives tool-related events but text deltas go to the conversation.
    def append_text(text, kind)
      return if text.nil? || text.empty?

      conversation = @run.conversation
      Turbo::StreamsChannel.broadcast_append_to(
        conversation,
        target: DomTargets.streaming_message(conversation),
        partial: "#{PARTIAL_ROOT}/text_delta",
        locals: { text: text, kind: kind }
      )
    end

    def tool_call_start(event)
      @tool_names[event.tool_call_id] = event.name
      Turbo::StreamsChannel.broadcast_append_to(
        @run,
        target: DomTargets.tools(@run),
        partial: "#{PARTIAL_ROOT}/tool_call",
        locals: {
          frame_id: DomTargets.tool_frame(@run, event.tool_call_id),
          name: event.name,
          args_json: pretty_json(event.args)
        }
      )
    end

    def tool_call_end(event)
      Turbo::StreamsChannel.broadcast_replace_to(
        @run,
        target: DomTargets.tool_frame(@run, event.tool_call_id),
        partial: "#{PARTIAL_ROOT}/tool_result",
        locals: {
          frame_id: DomTargets.tool_frame(@run, event.tool_call_id),
          name: @tool_names[event.tool_call_id],
          result: event.result,
          is_error: event.is_error ? true : false,
          duration_ms: event.duration_ms
        }
      )
    end

    # Replace the streaming message container with the persisted assistant message
    # and a fresh empty container for the next run. Called when the agent finishes
    # so the live deltas are swapped out for the durable record.
    def streaming_done
      conversation = @run.conversation
      message = conversation.messages.where(role: "assistant", run_id: @run.id).last
      return unless message

      target_id = DomTargets.streaming_message(conversation)

      # Single replace: swap the streaming placeholder for the final message
      # followed by a new empty streaming container.
      Turbo::StreamsChannel.broadcast_replace_to(
        conversation,
        target: target_id,
        partial: "ez_agent_rails/conversations/streaming_done",
        locals: { message: message, target_id: target_id }
      )
    end

    def status(kind, message)
      Turbo::StreamsChannel.broadcast_replace_to(
        @run,
        target: DomTargets.status(@run),
        partial: "#{PARTIAL_ROOT}/status",
        locals: { status_id: DomTargets.status(@run), kind: kind, message: message }
      )
    end

    def actions
      Turbo::StreamsChannel.broadcast_replace_to(
        @run,
        target: DomTargets.actions(@run),
        partial: "#{PARTIAL_ROOT}/actions",
        locals: { run: @run }
      )
    end

    # ── Action Cable (raw JSON) transport ──────────────────

    def broadcast_json(event)
      ActionCable.server.broadcast(
        RunChannel.stream_name_for(@run),
        EventPayload.payload_for(event)
      )
    end

    # ── status copy ────────────────────────────────────────

    def retry_message(event)
      "Retrying (#{event.reason}) — attempt #{event.attempt}/#{event.max_attempts}"
    end

    def done_message(event)
      usage = event.total_usage
      parts = ["Completed #{event.total_turns} #{pluralize(event.total_turns, 'turn')}"]
      if usage
        parts << "#{usage.input_tokens} in / #{usage.output_tokens} out tokens"
      end
      parts.join(" · ")
    end

    def pluralize(count, word)
      count == 1 ? word : "#{word}s"
    end

    def pretty_json(value)
      JSON.pretty_generate(value)
    rescue StandardError
      value.to_s
    end

    # Build the HTML for a user message inline (avoids needing view helpers
    # that are unavailable in Turbo::StreamsChannel's renderer).
    def render_user_message_html(message)
      body = if message.content.is_a?(String)
               ActionController::Base.helpers.content_tag(:p, message.content)
             else
               message.content.to_s
             end
      attachments_html = render_attachments_html(message)
      <<~HTML.html_safe
        <div class="ez-agent-message ez-agent-message--user" data-role="user">
          <div class="ez-agent-message__role">user</div>
          #{attachments_html}
          <div class="ez-agent-message__body">#{body}</div>
        </div>
      HTML
    end

    # Render file attachment previews for a user message. Images are shown as
    # base64 inline thumbnails; other files get an icon + filename.
    def render_attachments_html(message)
      attachments = message.file_attachments
      return "" unless attachments.is_a?(Array) && attachments.any?

      h = ActionController::Base.helpers
      items = attachments.filter_map do |att|
        name = h.escape(att["name"].to_s)
        ct = att["content_type"].to_s
        if ct.start_with?("image/") && att["path"].present? && File.exist?(att["path"].to_s)
          data = Base64.strict_encode64(File.binread(att["path"]))
          h.content_tag(:div, class: "ez-agent-message__attachment ez-agent-message__attachment--image") do
            h.content_tag(:img, "", src: "data:#{ct};base64,#{data}", alt: name, class: "ez-agent-message__attachment-img") +
            h.content_tag(:span, name, class: "ez-agent-message__attachment-name")
          end
        else
          size = att["size"] ? h.number_to_human_size(att["size"]) : ""
          h.content_tag(:div, class: "ez-agent-message__attachment ez-agent-message__attachment--file") do
            h.content_tag(:span, h.content_tag(:i, "", data: { lucide: "file" }), class: "ez-agent-message__attachment-icon") +
            h.content_tag(:span, name, class: "ez-agent-message__attachment-name") +
            h.content_tag(:span, size, class: "ez-agent-message__attachment-size")
          end
        end
      end
      h.content_tag(:div, items.join.html_safe, class: "ez-agent-message__attachments")
    end
  end
end
