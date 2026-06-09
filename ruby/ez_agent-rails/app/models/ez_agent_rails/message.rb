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

    belongs_to :run,
               class_name: "EZAgentRails::Run",
               foreign_key: :run_id,
               inverse_of: :messages,
               optional: true

    validates :role, presence: true

    after_create :increment_conversation_message_count
    after_destroy :decrement_conversation_message_count

    # The provider name from the associated run, if any.
    # @return [String, nil]
    def provider_name
      run&.provider
    end

    # The model id from the associated run, if any.
    # @return [String, nil]
    def model_name
      run&.model
    end

    # Rebuild the framework message Hash for this row. Content read back from the
    # JSON column has String keys; {EZAgentRails.deep_symbolize} restores symbol
    # keys so the round-trip is lossless against the original input.
    #
    # @return [Hash]
    def to_llm_message
      { role: role, content: EZAgentRails.deep_symbolize(content) }
    end

    private

    def increment_conversation_message_count
      conversation.increment!(:message_count)
    end

    def decrement_conversation_message_count
      # Skip when the parent is being cascade-destroyed (dependent: :destroy):
      # there is no point updating a counter on a row that is about to be deleted.
      return if conversation.destroyed?

      conversation.decrement!(:message_count)
    end
  end
end
