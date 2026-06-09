# frozen_string_literal: true

module EZLLM
  # An error originating from a model provider (HTTP error, billing stop, rate
  # limit). Carries the provider slug, HTTP status, and an optional reset time
  # (unix seconds) when the provider reports when a usage/rate limit clears.
  class ProviderError < Error
    attr_reader :provider, :status_code, :resets_at

    def initialize(provider, message, status_code: nil, request_id: nil, hint: nil,
                   cause: nil, resets_at: nil)
      super(message, source: :provider, request_id: request_id, hint: hint, cause: cause)
      @provider = provider
      @status_code = status_code
      @resets_at = resets_at
    end
  end
end
