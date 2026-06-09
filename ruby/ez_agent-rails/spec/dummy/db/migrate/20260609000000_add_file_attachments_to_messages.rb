# frozen_string_literal: true

class AddFileAttachmentsToMessages < ActiveRecord::Migration[7.1]
  def change
    add_column :ez_agent_rails_messages, :file_attachments, :json
  end
end
