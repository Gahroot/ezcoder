# frozen_string_literal: true

module EZAgentRails
  # Drives one {EZAgent::Loop} pass for a {Run}, off the request cycle.
  #
  # Given a Run id and the user's prompt it: appends the prompt to the run's
  # {Conversation}, builds a loop from {EZAgentRails.configuration}
  # (provider/model/tools + credentials via the configured resolver), replays the
  # prior messages through {Conversation#to_llm_messages}, runs the loop while
  # streaming every event to a {Broadcaster} (Turbo + raw JSON), persists each
  # tool result as it completes plus the final assistant message and usage, and
  # marks the run `succeeded`.
  #
  # Any raise is caught: the run is marked `failed` with the error message and a
  # status update is broadcast, so a run is never left stuck in `running`. The
  # error is re-raised afterwards so the job backend can log/retry per app policy.
  #
  # Two OPTIONAL features are wired here when the host opts in:
  #   * Human-in-the-loop approval ({RailsApprovalGate}) — only when
  #     `configuration.approval_enabled`. Gated tools block the job until a web
  #     request records a decision (the run never hangs: timeout/stop both deny).
  #   * Cooperative cancellation ({Cancellation}) — always passed. A web request
  #     stamping the run's `aborted_at` stops the loop at its next boundary; the
  #     run is finalized `aborted` (a clean stop, never re-raised).
  class RunJob < ActiveJob::Base
    queue_as :default

    # @param run_id [Integer] the {Run} to drive
    # @param prompt [String, nil] the user turn to append before running
    # @return [void]
    def perform(run_id, prompt = nil)
      run = Run.find(run_id)
      broadcaster = Broadcaster.new(run)

      begin
        drive(run, prompt, broadcaster)
      rescue EZAgent::Cancellation::Aborted
        # The loop unwound at a boundary because the run was stopped (durable
        # `aborted_at`). That is a clean stop, not a failure: mark it aborted and
        # do NOT re-raise (nothing to retry).
        run.record_aborted
        broadcaster.run_aborted
      rescue StandardError => e
        run.record_failure(e)
        broadcaster.call(failure_event(e))
        raise
      end
    end

    private

    def drive(run, prompt, broadcaster)
      conversation = run.conversation
      conversation.append_message(role: "user", content: prompt) if prompt.present?

      cancellation = Cancellation.new(run)
      result = build_loop(run, broadcaster, cancellation).run(
        messages: conversation.to_llm_messages,
        credentials: EZAgentRails.credentials_for(run.provider, context: conversation),
        cancellation: cancellation
      ) { |event| on_event(event, broadcaster, conversation) }

      conversation.append_message(result.message)

      # The loop can also return a Result (rather than raise Aborted) when the
      # abort lands mid-tool-execution. Honor the durable flag either way.
      if cancellation.aborted?
        run.record_aborted(result)
        broadcaster.run_aborted
      else
        run.record_result(result)
      end
    end

    # Fan each loop event to the live transports (Broadcaster) AND persist tool
    # results as they complete, so a reloaded conversation shows the tool calls
    # the agent made — not just its final answer. Persisted tool-result messages
    # are unpaired in history (the assistant tool_use turn isn't reconstructed),
    # which the loop's `repair_tool_pairing!` safely strips on any later run.
    def on_event(event, broadcaster, conversation)
      persist_tool_result(conversation, event) if event.type == :tool_call_end
      broadcaster.call(event)
    end

    def persist_tool_result(conversation, event)
      block = EZLLM::Types.tool_result(
        tool_call_id: event.tool_call_id,
        content: event.result,
        is_error: event.is_error || nil
      )
      conversation.append_message(role: "tool", content: [block])
    end

    def build_loop(run, broadcaster, cancellation)
      config = EZAgentRails.configuration
      EZAgent::Loop.new(
        provider: run.provider.to_sym,
        model: run.model,
        tools: config.tools,
        fence_untrusted: config.fence_untrusted,
        approval: build_approval_gate(run, broadcaster, cancellation, config)
      )
    end

    # Wire the human-in-the-loop gate only when the host app opts in. When off,
    # the loop runs with no gate and every tool auto-executes. The gate shares the
    # run's cancellation so a stopped run releases any parked confirmation.
    def build_approval_gate(run, broadcaster, cancellation, config)
      return nil unless config.approval_enabled

      RailsApprovalGate.new(
        run: run,
        broadcaster: broadcaster,
        cancellation: cancellation,
        poll_interval: config.approval_poll_interval,
        timeout: config.approval_timeout
      )
    end

    # Surface an out-of-band raise (one the loop's own recovery didn't emit) to
    # the UI as a terminal error status, reusing the Broadcaster's event mapping.
    def failure_event(error)
      EZAgent::Event::AgentError.new(seq: -1, error: error)
    end
  end
end
