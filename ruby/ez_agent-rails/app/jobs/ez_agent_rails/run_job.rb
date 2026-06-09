# frozen_string_literal: true

module EZAgentRails
  # Drives one {EZAgent::Loop} pass for a {Run}, off the request cycle.
  #
  # Given a Run id and the user's prompt it: appends the prompt to the run's
  # {Conversation}, builds a loop from {EZAgentRails.configuration}
  # (provider/model/tools + credentials via the configured resolver), replays the
  # prior messages through {Conversation#to_llm_messages}, runs the loop while
  # streaming every event to a {Broadcaster} (Turbo + raw JSON), persists each
  # tool result as it completes plus the final assistant message and usage, and
  # marks the run `succeeded`.
  #
  # Any raise is caught: the run is marked `failed` with the error message and a
  # status update is broadcast, so a run is never left stuck in `running`. The
  # error is re-raised afterwards so the job backend can log/retry per app policy.
  #
  # Two OPTIONAL features are wired here when the host opts in:
  #   * Human-in-the-loop approval ({RailsApprovalGate}) — only when
  #     `configuration.approval_enabled`. Gated tools block the job until a web
  #     request records a decision (the run never hangs: timeout/stop both deny).
  #   * Cooperative cancellation ({Cancellation}) — always passed. A web request
  #     stamping the run's `aborted_at` stops the loop at its next boundary; the
  #     run is finalized `aborted` (a clean stop, never re-raised).
  class RunJob < ActiveJob::Base
    queue_as :default

    # @param run_id [Integer] the {Run} to drive
    # @param prompt [String, nil] the user turn to append before running
    # @param file_attachments [Array<Hash>, nil] uploaded file metadata from RunsController
    # @return [void]
    def perform(run_id, prompt = nil, file_attachments = [])
      run = Run.find(run_id)
      broadcaster = Broadcaster.new(run)

      begin
        drive(run, prompt, broadcaster, file_attachments)
      rescue EZAgent::Cancellation::Aborted
        # The loop unwound at a boundary because the run was stopped (durable
        # `aborted_at`). That is a clean stop, not a failure: mark it aborted and
        # do NOT re-raise (nothing to retry).
        run.record_aborted
        broadcaster.run_aborted
      rescue StandardError => e
        run.record_failure(e)
        broadcaster.call(failure_event(e))
        raise
      ensure
        # Regardless of how the run ended (success, abort, or failure), swap
        # the Stop button → Regenerate so the user can re-run from the same
        # conversation state.
        broadcaster&.run_finished
      end
    end

    private

    def drive(run, prompt, broadcaster, file_attachments = [])
      run.mark_started!
      conversation = run.conversation
      if prompt.present? || file_attachments.any?
        content = build_user_content(prompt, file_attachments)
        user_msg = conversation.messages.create!(
          role: "user", content: content, run_id: run.id,
          file_attachments: file_attachments.presence
        )
        broadcaster.user_message(user_msg)
        auto_set_title(conversation, prompt) if conversation.title.blank? && prompt.present?
      end

      @turn_started_at = monotonic_ms
      cancellation = Cancellation.new(run)
      result = build_loop(run, broadcaster, cancellation).run(
        messages: conversation.to_llm_messages,
        credentials: EZAgentRails.credentials_for(run.provider, context: conversation),
        cancellation: cancellation
      ) { |event| on_event(event, broadcaster, conversation, run) }

      conversation.append_message(result.message, run_id: run.id)

      # The loop can also return a Result (rather than raise Aborted) when the
      # abort lands mid-tool-execution. Honor the durable flag either way.
      if cancellation.aborted?
        run.record_aborted(result)
        broadcaster.run_aborted
      else
        run.record_result(result)
      end
    end

    # Fan each loop event to the live transports (Broadcaster) AND persist tool
    # results as they complete, so a reloaded conversation shows the tool calls
    # the agent made — not just its final answer. Persisted tool-result messages
    # are unpaired in history (the assistant tool_use turn isn't reconstructed),
    # which the loop's `repair_tool_pairing!` safely strips on any later run.
    def on_event(event, broadcaster, conversation, run)
      case event.type
      when :tool_call_end
        persist_tool_result(conversation, event, run)
      when :turn_end
        record_turn_latency(run, event)
      when :retry
        run.record_retry!(event.reason)
      end
      broadcaster.call(event)
    end

    def persist_tool_result(conversation, event, run)
      block = EZLLM::Types.tool_result(
        tool_call_id: event.tool_call_id,
        content: event.result,
        is_error: event.is_error || nil
      )
      conversation.append_message(role: "tool", content: [block], run_id: run.id)
    end

    def record_turn_latency(run, event)
      return unless @turn_started_at

      latency_ms = monotonic_ms - @turn_started_at
      run.record_turn_latency!(event.turn, latency_ms)
      @turn_started_at = monotonic_ms
    end

    def build_loop(run, broadcaster, cancellation)
      config = EZAgentRails.configuration
      EZAgent::Loop.new(
        provider: run.provider.to_sym,
        model: run.model,
        tools: config.tools,
        system: config.system_prompt,
        fence_untrusted: config.fence_untrusted,
        approval: build_approval_gate(run, broadcaster, cancellation, config)
      )
    end

    # Wire the human-in-the-loop gate only when the host app opts in. When off,
    # the loop runs with no gate and every tool auto-executes. The gate shares the
    # run's cancellation so a stopped run releases any parked confirmation.
    def build_approval_gate(run, broadcaster, cancellation, config)
      return nil unless config.approval_enabled

      RailsApprovalGate.new(
        run: run,
        broadcaster: broadcaster,
        cancellation: cancellation,
        poll_interval: config.approval_poll_interval,
        timeout: config.approval_timeout
      )
    end

    # Surface an out-of-band raise (one the loop's own recovery didn't emit) to
    # the UI as a terminal error status, reusing the Broadcaster's event mapping.
    def failure_event(error)
      EZAgent::Event::AgentError.new(seq: -1, error: error)
    end

    # Auto-generate a conversation title from the first user message when the
    # title is still blank. Truncates to 80 characters so sidebar entries stay
    # readable.
    def auto_set_title(conversation, prompt)
      text = prompt.to_s.strip
      text = text[0...77] + "..." if text.length > 80
      conversation.update_column(:title, text)
    end

    def monotonic_ms
      (Process.clock_gettime(Process::CLOCK_MONOTONIC) * 1000).to_i
    end

    # Build the user message content as either a plain String (when there are
    # no attachments) or an Array of content blocks including image and text
    # blocks for uploaded files. Images are sent as base64 image blocks; text-
    # readable files (code, CSV, JSON, etc.) are inlined as text so the LLM
    # can read them directly.
    #
    # @param prompt [String, nil]
    # @param file_attachments [Array<Hash>]
    # @return [String, Array<Hash>]
    def build_user_content(prompt, file_attachments)
      return prompt if file_attachments.blank?

      blocks = []
      blocks << EZLLM::Types.text(prompt) if prompt.present?

      file_attachments.each do |att|
        path = att["path"].to_s
        next unless path.present? && File.exist?(path)

        if image_attachment?(att)
          media_type = infer_media_type(att)
          data = Base64.strict_encode64(File.binread(path))
          blocks << EZLLM::Types.image(media_type: media_type, data: data)
        elsif text_readable_attachment?(att)
          content = File.read(path, encoding: "UTF-8", invalid: :replace, undef: :replace)
          name = att["name"].to_s
          blocks << EZLLM::Types.text("[File: #{name}]\n#{content}")
        else
          # Binary non-image (e.g. PDF) — include a placeholder so the LLM
          # knows a file was attached even though its contents aren't inline.
          name = att["name"].to_s
          size = att["size"] ? " (#{att["size"]} bytes)" : ""
          blocks << EZLLM::Types.text("[Attached file: #{name}#{size} — binary content not inline]")
        end
      end

      blocks.any? ? blocks : prompt
    end

    # Image extensions that LLMs accept as image content blocks.
    IMAGE_EXTENSIONS = %w[.png .jpg .jpeg .gif .webp .svg .bmp .tiff .tif].freeze

    # Extensions whose content can be read as UTF-8 text and inlined.
    TEXT_EXTENSIONS = %w[
      .txt .md .csv .json .xml .html .htm .css .js .ts .jsx .tsx
      .py .rb .go .rs .java .c .cpp .h .hpp .sh .sql
      .yaml .yml .toml .ini .cfg .conf .env
      .r .R .jl .ex .exs .erl .hs .lua .php .swift .kt
      .tsv .log .diff .patch .gitignore .dockerfile
    ].freeze

    # @param att [Hash]
    # @return [Boolean]
    def image_attachment?(att)
      ct = att["content_type"].to_s
      return true if ct.start_with?("image/")

      ext = File.extname(att["name"].to_s).downcase
      IMAGE_EXTENSIONS.include?(ext)
    end

    # Detect text-readable files by content_type or extension.
    #
    # @param att [Hash]
    # @return [Boolean]
    def text_readable_attachment?(att)
      ct = att["content_type"].to_s
      return true if ct.start_with?("text/")
      return true if ct == "application/json" || ct == "application/xml"

      ext = File.extname(att["name"].to_s).downcase
      TEXT_EXTENSIONS.include?(ext)
    end

    # Infer the media_type from the stored content_type or file extension.
    #
    # @param att [Hash]
    # @return [String]
    def infer_media_type(att)
      ct = att["content_type"].to_s
      return ct if ct.start_with?("image/")

      ext = File.extname(att["name"].to_s).downcase
      case ext
      when ".png"  then "image/png"
      when ".jpg", ".jpeg" then "image/jpeg"
      when ".gif"  then "image/gif"
      when ".webp" then "image/webp"
      when ".svg"  then "image/svg+xml"
      when ".bmp"  then "image/bmp"
      when ".tiff", ".tif" then "image/tiff"
      else "application/octet-stream"
      end
    end
  end
end
