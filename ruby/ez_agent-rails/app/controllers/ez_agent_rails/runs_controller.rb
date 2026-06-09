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
      provider = selected_provider
      model = selected_model(provider)
      @run = conversation.runs.create!(provider: provider, model: model)
      file_attachments = store_uploaded_files(conversation, params[:files])
      RunJob.perform_later(@run.id, params[:prompt], file_attachments)

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

    def selected_provider
      raw = params[:provider].to_s.strip
      return EZAgentRails.configuration.default_provider.to_s if raw.empty?

      raw
    end

    def selected_model(provider)
      raw = params[:model].to_s.strip
      return EZAgentRails.configuration.default_model if raw.empty?

      raw
    end

    # Persist uploaded files to disk and return an array of metadata hashes
    # suitable for RunJob to convert into LLM content blocks.
    #
    # @param conversation [EZAgentRails::Conversation]
    # @param files [Array<ActionDispatch::Http::UploadedFile>, nil]
    # @return [Array<Hash>]
    def store_uploaded_files(conversation, files)
      return [] unless files.present?

      upload_dir = Rails.root.join("storage", "ez_agent_uploads", conversation.id.to_s)
      FileUtils.mkdir_p(upload_dir)

      Array(files).filter_map do |file|
        next unless file.respond_to?(:read)

        ext = File.extname(file.original_filename).presence || ".bin"
        safe_name = "#{SecureRandom.hex(8)}#{ext}"
        path = upload_dir.join(safe_name)
        File.open(path, "wb") { |io| io.write(file.read) }

        {
          "name" => file.original_filename,
          "content_type" => (file.content_type.presence || "application/octet-stream"),
          "size" => file.size,
          "path" => path.to_s
        }
      end
    end
  end
end
