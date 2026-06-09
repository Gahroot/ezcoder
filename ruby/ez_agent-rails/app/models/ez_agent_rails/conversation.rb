# frozen_string_literal: true

module EZAgentRails
  # A persisted conversation: an ordered list of {Message} rows plus the {Run}
  # rows that drove the agent loop over them. Bridges the database and the
  # framework's plain-Hash message shape via {#to_llm_messages} / {#append_message}.
  class Conversation < ApplicationRecord
    has_many :messages, -> { order(:position) },
             class_name: "EZAgentRails::Message",
             foreign_key: :conversation_id,
             inverse_of: :conversation,
             dependent: :destroy

    has_many :runs,
             class_name: "EZAgentRails::Run",
             foreign_key: :conversation_id,
             inverse_of: :conversation,
             dependent: :destroy

    # ── Sidebar helpers ────────────────────────────────────────

    # Display title for the sidebar and headers: the stored title or a fallback.
    # @return [String]
    def display_title
      title.presence || "New Conversation"
    end

    # Extract preview text from the first user message for the sidebar.
    # Truncated to 80 characters. Returns nil when no user messages exist.
    #
    # @return [String, nil]
    def preview_text
      msg = first_user_message
      return nil unless msg

      text = extract_text_content(msg)
      text.length > 80 ? "#{text[0...77]}..." : text
    end

    # `message_count` is a real counter-cache column on this table, kept in sync
    # by {Message}'s create/destroy callbacks. It is read directly (no per-row
    # COUNT query) when rendering the conversation sidebar list.

    # Materialize the conversation as the array of framework message Hashes that
    # {EZAgent::Loop#run} expects: `[{ role:, content: }, ...]` with symbol keys,
    # ordered by position.
    #
    # @return [Array<Hash>]
    def to_llm_messages
      messages.order(:position).map(&:to_llm_message)
    end

    # Append a framework message Hash (`{ role:, content: }`, string or symbol
    # keys) as the next {Message} row. `content` may be a String or an Array of
    # content blocks; it is stored as JSON and round-trips losslessly.
    #
    # @param message [Hash]
    # @param run_id [Integer, nil] optional link to the run that produced this message
    # @return [EZAgentRails::Message]
    def append_message(message = nil, run_id: nil, **message_attrs)
      if message.is_a?(Hash)
        role = message[:role] || message["role"]
        content = message.key?(:content) ? message[:content] : message["content"]
      elsif message_attrs.any?
        role = message_attrs[:role] || message_attrs["role"]
        content = message_attrs[:content] || message_attrs["content"]
      end
      messages.create!(role: role, content: content, position: next_position, run_id: run_id)
    end

    # Bulk form of {#append_message}, preserving input order.
    #
    # @param message_list [Array<Hash>]
    # @return [Array<EZAgentRails::Message>]
    def append_messages(message_list)
      message_list.map { |m| append_message(m) }
    end

    private

    # Find the first message with role "user". Uses the already-loaded
    # collection when messages are eager-loaded; falls back to a query.
    # @return [EZAgentRails::Message, nil]
    def first_user_message
      if messages.loaded?
        messages.find { |m| m.role == "user" }
      else
        messages.where(role: "user").order(:position).first
      end
    end

    # Pull readable text from a message's content (String or content blocks).
    # @return [String]
    def extract_text_content(message)
      content = message.to_llm_message[:content]
      return content.to_s if content.is_a?(String)
      return "" unless content.is_a?(Array)

      content
        .select { |b| b[:type] == "text" }
        .map { |b| b[:text].to_s }
        .join(" ")
        .strip
    end

    # The next sequential position (0-based), one past the current max.
    def next_position
      (messages.maximum(:position) || -1) + 1
    end
  end
end
