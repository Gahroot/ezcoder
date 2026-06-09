# frozen_string_literal: true

require "rails_helper"

# The raw-JSON fallback transport: subscribe with a run id, stream the run's
# event channel; reject unknown runs so a bad subscription fails fast.
RSpec.describe EZAgentRails::RunChannel, type: :channel do
  let(:conversation) { EZAgentRails::Conversation.create! }
  let(:run) { conversation.runs.create!(provider: "fake", model: "fake-1") }

  before { stub_connection }

  it "streams from the run's event stream when the run exists" do
    subscribe(run_id: run.id)

    expect(subscription).to be_confirmed
    expect(subscription).to have_stream_from(described_class.stream_name_for(run))
  end

  it "rejects the subscription when the run is unknown" do
    subscribe(run_id: -1)

    expect(subscription).to be_rejected
  end

  it "derives a stable, run-scoped stream name" do
    expect(described_class.stream_name_for(run)).to eq("ez_agent_rails:run:#{run.id}:events")
  end
end
