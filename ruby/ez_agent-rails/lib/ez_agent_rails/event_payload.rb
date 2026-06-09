# frozen_string_literal: true

module EZAgentRails
  # Converts an {EZAgent::Event} (an immutable Data value object) into a plain,
  # JSON-safe Hash. Used by {RunChannel} to stream raw events to non-Hotwire
  # consumers that want the structured event rather than rendered HTML.
  #
  # Every payload carries `type` (Symbol) and `seq` (monotonic Integer); the rest
  # of the keys depend on the event. Exceptions and {EZLLM::Usage} value objects
  # are flattened to strings/hashes so the result round-trips through JSON.
  module EventPayload
    module_function

    # @param event [EZAgent::Event::*]
    # @return [Hash]
    def payload_for(event)
      base = { type: event.type, seq: event.seq }
      base.merge(details_for(event))
    end

    # @param usage [EZLLM::Usage, nil]
    # @return [Hash, nil]
    def usage_hash(usage)
      return nil if usage.nil?

      {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read: usage.cache_read,
        cache_write: usage.cache_write
      }
    end

    # @api private
    def details_for(event)
      case event.type
      when :text_delta, :thinking_delta
        { text: event.text }
      when :tool_call_start
        { tool_call_id: event.tool_call_id, name: event.name, args: event.args }
      when :tool_call_end
        { tool_call_id: event.tool_call_id, result: event.result,
          is_error: event.is_error, duration_ms: event.duration_ms }
      when :tool_confirm_request
        { tool_call_id: event.tool_call_id, name: event.name, args: event.args }
      when :turn_end
        { turn: event.turn, stop_reason: event.stop_reason, usage: usage_hash(event.usage) }
      when :agent_done
        { total_turns: event.total_turns, total_usage: usage_hash(event.total_usage) }
      when :retry
        { reason: event.reason, attempt: event.attempt,
          max_attempts: event.max_attempts, delay_ms: event.delay_ms, silent: event.silent }
      when :error
        { error: error_message(event.error) }
      else
        {}
      end
    end

    # @api private
    def error_message(error)
      error.respond_to?(:message) ? error.message : error.to_s
    end
  end
end
