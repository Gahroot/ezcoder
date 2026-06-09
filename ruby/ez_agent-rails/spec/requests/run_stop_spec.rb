# frozen_string_literal: true

require "rails_helper"

# POST /runs/:id/stop is the durable cooperative-cancellation entry point: it
# stamps `aborted_at` so a RunJob in another process stops at its next boundary.
RSpec.describe "EZAgentRails run stop", type: :request do
  let(:conversation) { EZAgentRails::Conversation.create! }
  let(:run) { conversation.runs.create!(provider: "fake", model: "fake-1") }

  it "stamps aborted_at and echoes it back as JSON" do
    expect(run.aborted_at).to be_nil

    post "/ez_agent/runs/#{run.id}/stop", as: :json

    expect(response).to have_http_status(:ok)
    expect(run.reload.aborted_at).to be_present
    expect(JSON.parse(response.body)["aborted_at"]).to be_present
  end

  it "is idempotent — the first stop time wins" do
    post "/ez_agent/runs/#{run.id}/stop", as: :json
    first = run.reload.aborted_at

    post "/ez_agent/runs/#{run.id}/stop", as: :json
    expect(run.reload.aborted_at.to_f).to be_within(0.001).of(first.to_f)
  end

  it "returns no content for an HTML post" do
    post "/ez_agent/runs/#{run.id}/stop"
    expect(response).to have_http_status(:no_content)
    expect(run.reload.aborted_at).to be_present
  end
end
