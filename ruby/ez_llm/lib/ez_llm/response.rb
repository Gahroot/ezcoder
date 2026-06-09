# frozen_string_literal: true

module EZLLM
  # Final result of a stream: the assembled assistant message, the normalized
  # stop reason, and token usage. Returned by EZLLM.stream and each provider.
  Response = Data.define(:message, :stop_reason, :usage)
end
