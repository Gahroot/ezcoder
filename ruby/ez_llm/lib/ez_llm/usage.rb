# frozen_string_literal: true

module EZLLM
  # Token accounting for one response. inputTokens excludes cache hits (matching
  # Anthropic's convention; the OpenAI provider subtracts cached tokens).
  Usage = Data.define(:input_tokens, :output_tokens, :cache_read, :cache_write) do
    def initialize(input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0)
      super
    end

    # Sum two usages — used by the agent loop to accumulate per-turn totals.
    def +(other)
      Usage.new(
        input_tokens: input_tokens + other.input_tokens,
        output_tokens: output_tokens + other.output_tokens,
        cache_read: cache_read + other.cache_read,
        cache_write: cache_write + other.cache_write
      )
    end

    def to_h
      { input_tokens: input_tokens, output_tokens: output_tokens,
        cache_read: cache_read, cache_write: cache_write }
    end
  end
end
