# frozen_string_literal: true

class AddRunIdToMessagesAndDiagnosticsToRuns < ActiveRecord::Migration[7.1]
  def change
    add_reference :ez_agent_rails_messages, :run,
                  foreign_key: { to_table: :ez_agent_rails_runs },
                  null: true

    add_column :ez_agent_rails_runs, :started_at, :datetime
    add_column :ez_agent_rails_runs, :retry_count, :integer, null: false, default: 0
    add_column :ez_agent_rails_runs, :stall_count, :integer, null: false, default: 0
    add_column :ez_agent_rails_runs, :turn_latencies, :json
  end
end
