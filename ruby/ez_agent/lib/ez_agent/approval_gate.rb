# frozen_string_literal: true

module EZAgent
  # OPTIONAL human-in-the-loop approval gate. Off by default; pass an instance to
  # Loop.new(approval:) to require consent before gated tools run. The gate holds
  # the "is this call allowed?" decision OUTSIDE the loop: the loop calls
  # `#request(...)` and the gate returns :allow / :deny / :always_allow.
  #
  # HOW the decision is obtained is the consumer's concern (the `decide` callable):
  #   - CLI: prompt on the terminal, return inline.
  #   - Web + background job: block on Redis BLPOP / DB poll until a controller
  #     records the user's click (the media-master pattern), then return.
  # The gate stays simple: it awaits a Ruby return value. A per-run allow-list
  # makes :always_allow sticky so the user isn't re-prompted every turn.
  #
  # Port of toolGate.ts + toolPolicy.ts.
  class ApprovalGate
    VALID_DECISIONS = %i[allow deny always_allow].freeze

    # @param decide [#call] callable receiving a request Hash
    #   { name:, args:, tool_call_id: } and returning :allow/:deny/:always_allow.
    # @param policy [ToolPolicy] which tools require confirmation.
    # @param mode [:interactive, :cron] in :cron there is no user; the gate uses
    #   `auto_confirm` to decide deterministically (media-master cron semantics).
    # @param auto_confirm [Boolean] cron-mode auto-approval for gated tools.
    def initialize(decide: nil, policy: ToolPolicy.new, mode: :interactive, auto_confirm: false, &block)
      @decide = decide || block
      @policy = policy
      @mode = mode
      @auto_confirm = auto_confirm
      @allow_list = {}
    end

    def requires_confirmation?(tool_name, tool = nil)
      @policy.requires_confirmation?(tool_name, tool)
    end

    # True when a call to `tool_name` would actually prompt the user (i.e. the
    # gate won't auto-resolve it via the always-allow list or cron mode). Lets
    # the loop emit a confirm event only when a real prompt happens.
    def prompt_needed?(tool_name)
      return false if @allow_list[tool_name.to_s]

      @mode != :cron
    end

    # Decide whether a gated tool call may proceed. Returns :allow/:deny.
    # :always_allow is recorded and collapses to :allow for this run.
    def request(name:, args:, tool_call_id: nil)
      key = name.to_s
      return :allow if @allow_list[key]

      if @mode == :cron
        return @auto_confirm ? :allow : :deny
      end

      decision = invoke_decide(name: name, args: args, tool_call_id: tool_call_id)
      decision = :deny unless VALID_DECISIONS.include?(decision)
      if decision == :always_allow
        @allow_list[key] = true
        return :allow
      end
      decision
    end

    private

    def invoke_decide(request)
      raise EZAgent::Error, "ApprovalGate requires a `decide` callable" unless @decide

      @decide.call(request)
    end
  end

  # Minimal namespaced error for the agent gem.
  class Error < StandardError; end
end
