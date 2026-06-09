# frozen_string_literal: true

module EZAgentRails
  # A {EZAgent::Cancellation} whose abort flag is DURABLE: it reads the run's
  # `aborted_at` column instead of (only) an in-process boolean. That is the whole
  # point — the {RunJob} drives the loop in a background process, but the user
  # clicks "Stop" in a totally separate web request
  # ({EZAgentRails::RunsController#stop}), which stamps `aborted_at`. Because
  # `#aborted?` re-reads the column, the in-flight loop notices at its next
  # turn/tool boundary even though the abort came from another process.
  #
  # The in-memory flag from the parent is kept too (via `super`), so a same-process
  # `#abort!` still works and short-circuits the DB read.
  class Cancellation < EZAgent::Cancellation
    # @param run [EZAgentRails::Run] the run whose `aborted_at` is the abort flag
    def initialize(run)
      super()
      @run_id = run.id
    end

    # Request cancellation AND persist it, so the stop survives the process. Then
    # delegate to the parent for the in-memory flag + on_abort callbacks.
    #
    # @return [void]
    def abort!
      EZAgentRails::Run.where(id: @run_id, aborted_at: nil).update_all(aborted_at: Time.current)
      super
    end

    # Aborted if EITHER the in-memory flag is set (same-process abort) OR the
    # run's durable `aborted_at` is stamped (cross-process stop). A deleted run is
    # treated as aborted so the loop can't spin against a vanished record.
    #
    # @return [Boolean]
    def aborted?
      return true if super

      scope = EZAgentRails::Run.where(id: @run_id)
      aborted_at = scope.pick(:aborted_at)
      return true if aborted_at.present?

      # No timestamp means either the run is still live OR the row vanished; a
      # missing row reads as aborted so the loop can't spin against it.
      !scope.exists?
    end
  end
end
