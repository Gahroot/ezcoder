# frozen_string_literal: true

module EZAgentRails
  # Event sink for a single {Run}. Pass `method(:call)` (or the instance itself,
  # which is callable) as the block to {EZAgent::Loop#run} and every
  # {EZAgent::Event} the loop yields is fanned out to two transports:
  #
  #   1. Hotwire/Turbo (PRIMARY) — a `<turbo-stream>` broadcast to the run's
  #      per-run stream (`Turbo::StreamsChannel`, keyed by the run record, the
  #      target of `turbo_stream_from run`). Text/thinking deltas APPEND into the
  #      stream target; each tool call APPENDS a frame that is REPLACED in place
  #      when it finishes; retry/error/agent_done REPLACE the status line. The
  #      event -> DOM mapping lives entirely in the `runs/` view partials.
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
      when :agent_done      then status(:done, done_message(event))
      end
    end

    # ── Turbo (HTML) transport ─────────────────────────────

    def append_text(text, kind)
      return if text.nil? || text.empty?

      Turbo::StreamsChannel.broadcast_append_to(
        @run,
        target: DomTargets.stream(@run),
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

    def status(kind, message)
      Turbo::StreamsChannel.broadcast_replace_to(
        @run,
        target: DomTargets.status(@run),
        partial: "#{PARTIAL_ROOT}/status",
        locals: { status_id: DomTargets.status(@run), kind: kind, message: message }
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
  end
end
