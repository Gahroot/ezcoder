# frozen_string_literal: true

module EZAgentRails
  # Kicks off and shows agent runs. `create` is the off-request entry point: it
  # records a {Run}, enqueues {RunJob} (which drives the loop in the background),
  # and returns the run's turbo-frame so the page can `turbo_stream_from run` and
  # watch events arrive live. No agent work happens in the request.
  class RunsController < ApplicationController
    # POST /conversations/:conversation_id/runs
    def create
      conversation = Conversation.find(params[:conversation_id])
      @run = conversation.runs.create!(
        provider: EZAgentRails.configuration.default_provider.to_s,
        model: EZAgentRails.configuration.default_model
      )
      RunJob.perform_later(@run.id, params[:prompt])

      respond_to do |format|
        format.html { render :create }
        format.json { render json: run_json(@run), status: :created }
      end
    end

    # GET /runs/:id
    def show
      @run = Run.find(params[:id])

      respond_to do |format|
        format.html { render :show }
        format.json { render json: run_json(@run) }
      end
    end

    # POST /runs/:id/stop
    #
    # Cooperative cancellation: stamp `aborted_at` so a RunJob driving this run's
    # loop in another process/thread observes it (via
    # {EZAgentRails::Cancellation#aborted?}) and stops at its next turn/tool
    # boundary. Idempotent and safe to call on an already-finished run.
    def stop
      @run = Run.find(params[:id])
      @run.request_stop!

      respond_to do |format|
        format.html { head :no_content }
        format.json { render json: run_json(@run) }
      end
    end

    private

    def run_json(run)
      {
        id: run.id,
        conversation_id: run.conversation_id,
        status: run.status,
        provider: run.provider,
        model: run.model,
        input_tokens: run.input_tokens,
        output_tokens: run.output_tokens,
        aborted_at: run.aborted_at,
        stream_name: RunChannel.stream_name_for(run)
      }
    end
  end
end
