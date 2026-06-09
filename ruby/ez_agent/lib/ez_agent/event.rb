# frozen_string_literal: true

module EZAgent
  # Events the agent loop yields to the consumer's block. A superset of the
  # ez_llm stream events: the raw text/thinking deltas pass through, and the loop
  # adds tool lifecycle, turn boundaries, retries, steering/follow-up, and the
  # terminal agent_done. Each carries a monotonic `seq` so any transport can
  # order them. Immutable Data value objects; `#type` is a symbol.
  #
  # Port of the AgentEvent union in packages/agent/src/types.ts (+ media-master
  # tool_confirm_request and seq numbering).
  module Event
    TextDelta = Data.define(:seq, :text) do
      def type = :text_delta
    end

    ThinkingDelta = Data.define(:seq, :text) do
      def type = :thinking_delta
    end

    ToolCallStart = Data.define(:seq, :tool_call_id, :name, :args) do
      def type = :tool_call_start
    end

    # Incremental progress from a running tool (via ToolContext#update).
    ToolCallUpdate = Data.define(:seq, :tool_call_id, :update) do
      def type = :tool_call_update
    end

    ToolCallEnd = Data.define(:seq, :tool_call_id, :result, :details, :is_error, :duration_ms) do
      def type = :tool_call_end
    end

    # Count of streamed tool-call argument characters (UI progress hint).
    ToolCallDelta = Data.define(:seq, :chars) do
      def type = :toolcall_delta
    end

    ServerToolCall = Data.define(:seq, :id, :name, :input) do
      def type = :server_tool_call
    end

    ServerToolResult = Data.define(:seq, :tool_use_id, :result_type, :data) do
      def type = :server_tool_result
    end

    # Emitted only when an approval gate is present and a gated tool is pending.
    ToolConfirmRequest = Data.define(:seq, :tool_call_id, :name, :args) do
      def type = :tool_confirm_request
    end

    SteeringMessage = Data.define(:seq, :content) do
      def type = :steering_message
    end

    FollowUpMessage = Data.define(:seq, :content) do
      def type = :follow_up_message
    end

    # A recoverable retry (overload/rate_limit/provider_error/empty_response/
    # stream_stall/overflow_compact). `silent` hints the UI to hide early retries.
    Retry = Data.define(:seq, :reason, :attempt, :max_attempts, :delay_ms,
                        :observed_tokens, :observed_limit, :silent) do
      def initialize(seq:, reason:, attempt:, max_attempts:, delay_ms:,
                     observed_tokens: nil, observed_limit: nil, silent: false)
        super
      end

      def type = :retry
    end

    # Context compaction happened (consumer's transform_context reduced history).
    Compacted = Data.define(:seq, :before, :after) do
      def type = :compacted
    end

    TurnEnd = Data.define(:seq, :turn, :stop_reason, :usage) do
      def type = :turn_end
    end

    AgentError = Data.define(:seq, :error) do
      def type = :error
    end

    AgentDone = Data.define(:seq, :total_turns, :total_usage) do
      def type = :agent_done
    end
  end
end
