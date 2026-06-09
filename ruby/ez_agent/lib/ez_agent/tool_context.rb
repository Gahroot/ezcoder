# frozen_string_literal: true

module EZAgent
  # Per-invocation context handed to a tool's #perform. Carries the cancellation
  # token (so long-running tools can cooperatively bail), the tool_call_id, an
  # `update` channel for streaming progress back to the consumer as
  # tool_call_update events, and an arbitrary `context` Hash the consumer passed
  # into Loop#run (e.g. the current user, tenant, request — whatever a tool that
  # "wraps your own code" needs). Port of ToolContext.
  class ToolContext
    attr_reader :tool_call_id, :cancellation, :context

    def initialize(tool_call_id:, cancellation: nil, context: nil, on_update: nil)
      @tool_call_id = tool_call_id
      @cancellation = cancellation
      @context = context || {}
      @on_update = on_update
    end

    # Stream a progress update to the consumer (surfaced as tool_call_update).
    def update(payload)
      @on_update&.call(payload)
    end

    def aborted?
      @cancellation.respond_to?(:aborted?) && @cancellation.aborted?
    end
  end
end
