# frozen_string_literal: true

module EZLLM
  # The active model can't handle video content left in the request (e.g. a
  # video block in history after switching to a text-only model). A clean,
  # user-facing capability error — not a bug, not a provider outage.
  class VideoUnsupportedError < Error
    def initialize(message = "This model can't analyze video.")
      super(message, source: :capability)
    end
  end
end
