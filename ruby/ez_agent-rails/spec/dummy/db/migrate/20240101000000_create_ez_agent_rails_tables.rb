# frozen_string_literal: true

# Concrete copy of the install generator's migration, used to build the dummy
# app's schema for the engine specs.
class CreateEZAgentRailsTables < ActiveRecord::Migration[7.1]
  def change
    create_table :ez_agent_rails_conversations do |t|
      t.string :title
      t.string :provider
      t.string :model
      t.integer :message_count, null: false, default: 0

      t.timestamps
    end

    create_table :ez_agent_rails_messages do |t|
      t.references :conversation, null: false,
                   foreign_key: { to_table: :ez_agent_rails_conversations }
      t.string :role, null: false
      t.json :content
      t.integer :position, null: false, default: 0

      t.timestamps
    end
    add_index :ez_agent_rails_messages, %i[conversation_id position]

    create_table :ez_agent_rails_runs do |t|
      t.references :conversation, null: false,
                   foreign_key: { to_table: :ez_agent_rails_conversations }
      t.string :status, null: false, default: "running"
      t.string :provider
      t.string :model
      t.integer :input_tokens, null: false, default: 0
      t.integer :output_tokens, null: false, default: 0
      t.text :error_message
      # Durable cooperative-cancellation flag. A web request (RunsController#stop)
      # stamps this so an in-flight RunJob in another process/thread aborts at its
      # next turn/tool boundary — see EZAgentRails::Cancellation.
      t.datetime :aborted_at

      t.timestamps
    end

    # Human-in-the-loop approval ledger. One row per gated tool call the agent
    # wants to make; the RunJob's gate parks on it (status "pending") until a web
    # request (ToolConfirmationsController#update) records the user's decision.
    create_table :ez_agent_rails_tool_confirmations do |t|
      t.references :run, null: false,
                   foreign_key: { to_table: :ez_agent_rails_runs }
      t.string :tool_name, null: false
      t.json :args
      t.string :tool_call_id
      t.string :status, null: false, default: "pending"

      t.timestamps
    end
    add_index :ez_agent_rails_tool_confirmations, %i[run_id status]
  end
end
