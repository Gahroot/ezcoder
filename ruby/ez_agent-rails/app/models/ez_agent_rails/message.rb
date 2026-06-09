# frozen_string_literal: true

module EZAgentRails
  # One message in a {Conversation}. Mirrors the framework's plain-Hash shape:
  # `role` is a String ("system"/"user"/"assistant"/"tool") and `content` is
  # either a String or an Array of content-block Hashes, persisted as JSON.
  class Message < ApplicationRecord
    belongs_to :conversation,
               class_name: "EZAgentRails::Conversation",
               foreign_key: :conversation_id,
               inverse_of: :messages

    validates :role, presence: true

    # Rebuild the framework message Hash for this row. Content read back from the
    # JSON column has String keys; {EZAgentRails.deep_symbolize} restores symbol
    # keys so the round-trip is lossless against the original input.
    #
    # @return [Hash]
    def to_llm_message
      { role: role, content: EZAgentRails.deep_symbolize(content) }
    end
  end
end
