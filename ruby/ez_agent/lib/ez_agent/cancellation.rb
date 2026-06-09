# frozen_string_literal: true

module EZAgent
  # Cooperative cancellation token — the Ruby replacement for AbortSignal. The
  # consumer holds it, calls `#abort!` to request cancellation, and the loop
  # checks `#aborted?` at turn boundaries and before each tool; ToolRunner also
  # honors it. Where the abort flag lives (in-memory, a Redis key, a DB column)
  # is the consumer's business — subclass and override `#aborted?` to back it
  # with anything. Optional: absent ⇒ the run proceeds to completion.
  class Cancellation
    # Raised when an aborted token is observed at a checkpoint.
    class Aborted < StandardError
      def initialize(message = "Operation aborted")
        super
      end
    end

    def initialize
      @aborted = false
      @callbacks = []
    end

    # Request cancellation. Idempotent; fires any registered callbacks once.
    def abort!
      return if @aborted

      @aborted = true
      @callbacks.each { |cb| safe_call(cb) }
      @callbacks.clear
    end

    def aborted?
      @aborted
    end

    # Raise Aborted if cancellation has been requested. Call at checkpoints.
    def check!
      raise Aborted if aborted?
    end

    # Register a callback fired when abort! is called (or immediately if already
    # aborted). Used by ToolRunner to interrupt a blocking tool thread.
    def on_abort(&block)
      return unless block

      if @aborted
        safe_call(block)
      else
        @callbacks << block
      end
    end

    private

    def safe_call(callback)
      callback.call
    rescue StandardError
      nil
    end
  end
end
