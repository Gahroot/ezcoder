# frozen_string_literal: true

module EZAgentRails
  # A DB-backed {EZAgent::ApprovalGate} for the web + background-job split.
  #
  # The agent loop runs inside a {RunJob}, off the request cycle, but the decision
  # to allow/deny a gated tool comes from a human clicking a button in a SEPARATE
  # web request. There is no shared promise to await across that boundary, so this
  # gate makes the pending decision DURABLE: its `decide` callable
  #
  #   1. creates a {ToolConfirmation} row (status "pending"),
  #   2. broadcasts the confirm UI (Approve / Deny / Always) via the Broadcaster, then
  #   3. BLOCKS — polling the row until it reaches a terminal status.
  #
  # This is the Ruby/Rails port of media-master's toolGate: park on a pending
  # request keyed by a confirmation id; an external handler
  # ({ToolConfirmationsController#update}) resolves it. The critical "never hang"
  # property is preserved two ways — the poll honors {Cancellation} (a stopped run
  # returns `:deny` immediately) and a `timeout` floor (an unanswered prompt
  # eventually resolves to `:deny`), so the job can't block forever.
  #
  # The row's status maps 1:1 onto the gate's return symbol; `:always_allow` is
  # handled by the parent {EZAgent::ApprovalGate} (recorded in its per-run
  # allow-list and collapsed to `:allow`).
  class RailsApprovalGate < EZAgent::ApprovalGate
    DEFAULT_POLL_INTERVAL = 0.5
    DEFAULT_TIMEOUT = 300.0

    # @param run [EZAgentRails::Run] the run the gated calls belong to
    # @param broadcaster [#confirm_request, nil] sink for the confirm UI
    # @param cancellation [EZAgent::Cancellation, nil] stops a pending poll early
    # @param policy [EZAgent::ToolPolicy] which tools require confirmation
    # @param mode [:interactive, :cron] forwarded to the parent gate
    # @param auto_confirm [Boolean] cron-mode auto-approval, forwarded to parent
    # @param poll_interval [Numeric] seconds between row polls (injectable for tests)
    # @param timeout [Numeric] seconds before an unanswered prompt resolves to :deny
    # @param clock [#call] monotonic seconds source (injectable for tests)
    # @param sleeper [#call] sleep(seconds) hook (injectable for tests)
    def initialize(run:, broadcaster: nil, cancellation: nil,
                   policy: EZAgent::ToolPolicy.new, mode: :interactive, auto_confirm: false,
                   poll_interval: DEFAULT_POLL_INTERVAL, timeout: DEFAULT_TIMEOUT,
                   clock: -> { Process.clock_gettime(Process::CLOCK_MONOTONIC) },
                   sleeper: ->(seconds) { sleep(seconds) })
      @run = run
      @broadcaster = broadcaster
      @cancellation = cancellation
      @poll_interval = poll_interval.to_f
      @timeout = timeout.to_f
      @clock = clock
      @sleeper = sleeper
      super(decide: method(:resolve_decision), policy: policy, mode: mode, auto_confirm: auto_confirm)
    end

    private

    # The `decide` callable handed to {EZAgent::ApprovalGate}. Parks a durable
    # ToolConfirmation, surfaces the confirm UI, and blocks for the verdict.
    #
    # @param request [Hash] { name:, args:, tool_call_id: }
    # @return [Symbol] :allow / :deny / :always_allow
    def resolve_decision(request)
      confirmation = @run.tool_confirmations.create!(
        tool_name: request[:name].to_s,
        args: request[:args],
        tool_call_id: request[:tool_call_id],
        status: "pending"
      )
      @broadcaster&.confirm_request(confirmation)
      wait_for_decision(confirmation)
    end

    # Block until the row reaches a terminal status, the run is cancelled, or the
    # timeout elapses. Cancellation and timeout both deny (and durably stamp the
    # row "deny") so a parked job is always released.
    #
    # @param confirmation [EZAgentRails::ToolConfirmation]
    # @return [Symbol] :allow / :deny / :always_allow
    def wait_for_decision(confirmation)
      deadline = @clock.call + @timeout
      loop do
        return force_deny(confirmation) if @cancellation&.aborted?

        status = current_status(confirmation)
        return status.to_sym unless status == "pending"
        return force_deny(confirmation) if @clock.call >= deadline

        @sleeper.call(@poll_interval)
      end
    end

    # Re-read just the status column so a decision committed by another
    # process/connection is observed. A vanished row reads as "deny".
    def current_status(confirmation)
      EZAgentRails::ToolConfirmation.where(id: confirmation.id).pick(:status) || "deny"
    end

    # Resolve a still-pending row to "deny" (cancellation / timeout) and return
    # the gate's deny symbol. Only flips a row that is still pending so a racing
    # user decision already recorded is never clobbered.
    def force_deny(confirmation)
      EZAgentRails::ToolConfirmation
        .where(id: confirmation.id, status: "pending")
        .update_all(status: "deny", updated_at: Time.current)
      :deny
    end
  end
end
