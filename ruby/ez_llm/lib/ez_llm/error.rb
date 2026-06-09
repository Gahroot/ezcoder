# frozen_string_literal: true

module EZLLM
  # Base error for EZLLM and downstream consumers. Carries a machine-readable
  # `source` so a UI can answer "is this me or them?" — driving whether the user
  # retries, switches model, logs in, or reports a bug. Mirrors EZCoderAIError.
  class Error < StandardError
    # One of: :provider, :ezllm, :network, :auth, :capability
    attr_reader :source, :request_id, :hint

    def initialize(message, source: :ezllm, request_id: nil, hint: nil, cause: nil)
      super(message)
      @source = source
      @request_id = request_id
      @hint = hint
      @cause_override = cause
    end

    # Ruby sets #cause from the active $! at raise time; allow an explicit one.
    def cause
      @cause_override || super
    end
  end
end
