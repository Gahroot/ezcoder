# frozen_string_literal: true

module EZLLM
  # Stream events emitted by providers, modelled as immutable Data value objects
  # (the Ruby idiom for TS discriminated unions). Each exposes `#type` as a
  # symbol so consumers can `case event.type` or pattern-match the class.
  #
  # Port of the StreamEvent union in packages/ai/src/types.ts.
  module Event
    # Incremental assistant text.
    TextDelta = Data.define(:text) do
      def type = :text_delta
    end

    # Incremental reasoning/thinking text (Anthropic thinking, GLM/Kimi/MiMo
    # reasoning_content, DeepSeek reasoner).
    ThinkingDelta = Data.define(:text) do
      def type = :thinking_delta
    end

    # A chunk of a tool call's streamed JSON arguments.
    ToolCallDelta = Data.define(:id, :name, :args_json) do
      def type = :toolcall_delta
    end

    # A tool call finished accumulating; `args` is the parsed Hash.
    ToolCallDone = Data.define(:id, :name, :args) do
      def type = :toolcall_done
    end

    # Provider-native (server-side) tool call, e.g. Anthropic web_search.
    ServerToolCall = Data.define(:id, :name, :input) do
      def type = :server_toolcall
    end

    # Result of a provider-native tool call.
    ServerToolResult = Data.define(:tool_use_id, :result_type, :data) do
      def type = :server_toolresult
    end

    # Terminal event carrying the normalized stop reason.
    Done = Data.define(:stop_reason) do
      def type = :done
    end

    # An error surfaced mid-stream.
    Error = Data.define(:error) do
      def type = :error
    end

    # Heartbeat — proves API liveness so idle timers reset. Not user-visible.
    Keepalive = Data.define do
      def type = :keepalive
    end
  end
end
