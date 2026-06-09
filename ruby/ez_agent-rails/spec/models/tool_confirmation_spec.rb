# frozen_string_literal: true

require "rails_helper"

RSpec.describe EZAgentRails::ToolConfirmation, type: :model do
  let(:conversation) { EZAgentRails::Conversation.create! }
  let(:run) { conversation.runs.create!(provider: "fake", model: "fake-1") }

  it "belongs to a run and defaults to pending" do
    confirmation = run.tool_confirmations.create!(tool_name: "danger_write", args: { "path" => "x" })
    expect(confirmation.run).to eq(run)
    expect(confirmation).to be_pending
    expect(confirmation).not_to be_resolved
  end

  it "exposes the four gate statuses" do
    expect(described_class.statuses.keys).to contain_exactly("pending", "allow", "deny", "always_allow")
  end

  it "round-trips JSON args" do
    confirmation = run.tool_confirmations.create!(
      tool_name: "danger_write",
      args: { "path" => "report.txt", "nested" => { "n" => 1 } }
    )
    expect(confirmation.reload.args).to eq("path" => "report.txt", "nested" => { "n" => 1 })
  end

  it "is destroyed with its run" do
    run.tool_confirmations.create!(tool_name: "danger_write")
    expect { run.destroy }.to change(described_class, :count).by(-1)
  end

  it "requires a tool_name" do
    confirmation = run.tool_confirmations.build(tool_name: nil)
    expect(confirmation).not_to be_valid
  end
end
