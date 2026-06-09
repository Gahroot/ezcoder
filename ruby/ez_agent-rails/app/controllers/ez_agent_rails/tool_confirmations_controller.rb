# frozen_string_literal: true

module EZAgentRails
  # Records a human's allow/deny/always_allow decision for a parked gated tool
  # call. This is the "separate web request" half of the human-in-the-loop split:
  # the {RunJob}'s {RailsApprovalGate} created a {ToolConfirmation} (status
  # "pending") and is BLOCKED polling it; moving the row to a terminal status here
  # is what unblocks that job (the media-master `resolveConfirmation` entry point,
  # made durable).
  class ToolConfirmationsController < ApplicationController
    # POST /confirmations/:id  (params: decision = allow|deny|always_allow)
    def update
      confirmation = ToolConfirmation.find(params[:id])
      decision = params[:decision].to_s

      unless ToolConfirmation::DECISIONS.include?(decision)
        return respond_invalid(confirmation, decision)
      end

      # Only a still-pending row may be resolved, and only once — so a stale or
      # double click can't overwrite a decision the gate already consumed.
      changed = ToolConfirmation
                .where(id: confirmation.id, status: "pending")
                .update_all(status: decision, updated_at: Time.current)

      confirmation.reload
      Broadcaster.new(confirmation.run).confirm_resolved(confirmation) if changed.positive?

      respond_to do |format|
        format.html { head :no_content }
        format.json { render json: confirmation_json(confirmation, recorded: changed.positive?) }
      end
    end

    private

    def respond_invalid(confirmation, decision)
      respond_to do |format|
        format.html { head :unprocessable_content }
        format.json do
          render json: { error: "invalid decision: #{decision.inspect}", id: confirmation.id },
                 status: :unprocessable_content
        end
      end
    end

    def confirmation_json(confirmation, recorded:)
      {
        id: confirmation.id,
        run_id: confirmation.run_id,
        tool_name: confirmation.tool_name,
        tool_call_id: confirmation.tool_call_id,
        status: confirmation.status,
        recorded: recorded
      }
    end
  end
end
