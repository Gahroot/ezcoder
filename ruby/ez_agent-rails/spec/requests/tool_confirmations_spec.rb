# frozen_string_literal: true

require "rails_helper"

# The "separate web request" half of the human-in-the-loop split: recording a
# decision on a parked ToolConfirmation. (The end-to-end unblocking of a blocked
# RunJob is exercised in spec/jobs/run_hitl_spec.rb.)
RSpec.describe "EZAgentRails tool confirmations", type: :request do
  let(:conversation) { EZAgentRails::Conversation.create! }
  let(:run) { conversation.runs.create!(provider: "fake", model: "fake-1") }
  let(:confirmation) { run.tool_confirmations.create!(tool_name: "danger_write", args: { "path" => "x" }) }

  it "records an allow decision and reports it back as JSON" do
    post "/ez_agent/confirmations/#{confirmation.id}", params: { decision: "allow" }, as: :json

    expect(response).to have_http_status(:ok)
    body = JSON.parse(response.body)
    expect(body["status"]).to eq("allow")
    expect(body["recorded"]).to be(true)
    expect(confirmation.reload).to be_allow
  end

  it "records deny and always_allow" do
    post "/ez_agent/confirmations/#{confirmation.id}", params: { decision: "always_allow" }, as: :json
    expect(confirmation.reload).to be_always_allow
  end

  it "rejects an unknown decision and leaves the row pending" do
    post "/ez_agent/confirmations/#{confirmation.id}", params: { decision: "maybe" }, as: :json

    expect(response).to have_http_status(:unprocessable_content)
    expect(confirmation.reload).to be_pending
  end

  it "does not overwrite an already-resolved row (stale click)" do
    confirmation.update!(status: "deny")

    post "/ez_agent/confirmations/#{confirmation.id}", params: { decision: "allow" }, as: :json

    body = JSON.parse(response.body)
    expect(body["recorded"]).to be(false)
    expect(confirmation.reload).to be_deny
  end

  it "returns no content for an HTML post" do
    post "/ez_agent/confirmations/#{confirmation.id}", params: { decision: "deny" }
    expect(response).to have_http_status(:no_content)
    expect(confirmation.reload).to be_deny
  end
end
