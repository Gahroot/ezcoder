# frozen_string_literal: true

module EZAgent
  # Monotonic per-run event sequence counter. Each Loop#run owns one Sequence so
  # every emitted event gets a strictly increasing `seq`, giving any transport a
  # total order to ship/reorder against. Not thread-safe by design — a single
  # run yields events from one fiber/thread; the consumer owns concurrency.
  class Sequence
    def initialize
      @value = -1
    end

    def next
      @value += 1
    end
  end
end
