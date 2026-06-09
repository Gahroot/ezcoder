# frozen_string_literal: true

module EZAgentRails
  # The durable record of one human-in-the-loop approval request. The RunJob's
  # {EZAgentRails::RailsApprovalGate} creates a row (status "pending") for every
  # gated tool call the agent wants to make, then BLOCKS — polling this row — off
  # the request cycle. A separate web request
  # ({EZAgentRails::ToolConfirmationsController#update}) records the user's click
  # by moving the row to a terminal status, which unblocks the job.
  #
  # This is the media-master `pendingByConfirmationId` table made durable: instead
  # of an in-memory promise keyed by a confirmation id, the pending decision lives
  # in a row so the deciding request can be a different process entirely.
  class ToolConfirmation < ApplicationRecord
    belongs_to :run,
               class_name: "EZAgentRails::Run",
               foreign_key: :run_id,
               inverse_of: :tool_confirmations

    # The four states map 1:1 to {EZAgent::ApprovalGate}'s return symbols, plus
    # the initial "pending" the gate parks on. "always_allow" is sticky for the
    # rest of the run (the gate records it in its per-run allow-list).
    enum :status, {
      pending: "pending",
      allow: "allow",
      deny: "deny",
      always_allow: "always_allow"
    }, default: "pending"

    validates :tool_name, presence: true

    # The terminal decisions a controller may record. Excludes "pending" so a web
    # request can never re-park a row.
    DECISIONS = %w[allow deny always_allow].freeze

    # True once a decision has been recorded (the gate stops polling).
    def resolved?
      !pending?
    end
  end
end
