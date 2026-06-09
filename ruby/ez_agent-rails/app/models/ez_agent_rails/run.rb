# frozen_string_literal: true

module EZAgentRails
  # A single invocation of the agent loop over a {Conversation}: which
  # provider/model drove it, its lifecycle status, accumulated token usage, and
  # any terminal error. The host app creates a Run before calling
  # {EZAgent::Loop#run} and finalizes it with {#record_result} (or
  # {#record_usage} + a status transition).
  class Run < ApplicationRecord
    belongs_to :conversation,
               class_name: "EZAgentRails::Conversation",
               foreign_key: :conversation_id,
               inverse_of: :runs

    has_many :tool_confirmations,
             class_name: "EZAgentRails::ToolConfirmation",
             foreign_key: :run_id,
             inverse_of: :run,
             dependent: :destroy

    enum :status, {
      running: "running",
      succeeded: "succeeded",
      failed: "failed",
      aborted: "aborted"
    }, default: "running"

    validates :input_tokens, :output_tokens,
              numericality: { only_integer: true, greater_than_or_equal_to: 0 }

    # Copy token counts off an {EZLLM::Usage} (input + cache reads/writes count
    # as input). Does not persist on its own — pair with `save!`/`update!`.
    #
    # @param usage [EZLLM::Usage]
    # @return [self]
    def record_usage(usage)
      return self if usage.nil?

      self.input_tokens = usage.input_tokens.to_i + usage.cache_read.to_i + usage.cache_write.to_i
      self.output_tokens = usage.output_tokens.to_i
      self
    end

    # Finalize a successful run from an {EZAgent::Result}: record usage and mark
    # the run succeeded. Persists the change.
    #
    # @param result [EZAgent::Result]
    # @return [self]
    def record_result(result)
      record_usage(result.total_usage)
      self.status = "succeeded"
      save!
      self
    end

    # Finalize a failed run, capturing the error message. Persists the change.
    #
    # @param error [Exception, String]
    # @return [self]
    def record_failure(error)
      self.error_message = error.respond_to?(:message) ? error.message : error.to_s
      self.status = "failed"
      save!
      self
    end

    # Request cooperative cancellation from a web request: stamp `aborted_at` so a
    # RunJob running in another process/thread observes it (via
    # {EZAgentRails::Cancellation#aborted?}) and stops at its next boundary.
    # Idempotent — the first stamp wins so the original stop time is preserved.
    #
    # @return [self]
    def request_stop!
      update!(aborted_at: Time.current) unless aborted_at
      self
    end

    # Finalize a run the loop ended because it was cancelled: record any usage,
    # ensure `aborted_at` is set, and mark the run `aborted`. Persists the change.
    # Distinct from {#record_failure} — a stopped run is not an error.
    #
    # @param result [EZAgent::Result, nil]
    # @return [self]
    def record_aborted(result = nil)
      record_usage(result&.total_usage)
      self.aborted_at ||= Time.current
      self.status = "aborted"
      save!
      self
    end
  end
end
