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
    # @return [EZAgentRails::Message]
    def append_message(message)
      role = message[:role] || message["role"]
      content = message.key?(:content) ? message[:content] : message["content"]
      messages.create!(role: role, content: content, position: next_position)
    end

    # Bulk form of {#append_message}, preserving input order.
    #
    # @param message_list [Array<Hash>]
    # @return [Array<EZAgentRails::Message>]
    def append_messages(message_list)
      message_list.map { |m| append_message(m) }
    end

    private

    # The next sequential position (0-based), one past the current max.
    def next_position
      (messages.maximum(:position) || -1) + 1
    end
  end
end
