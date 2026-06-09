# frozen_string_literal: true

require "rails_helper"

# The off-request kickoff: POSTing a run enqueues the RunJob (no agent work in
# the request) and returns the run's turbo-frame so the page can subscribe.
RSpec.describe "EZAgentRails runs", type: :request do
  include ActiveJob::TestHelper

  around do |example|
    EZAgentRails.reset_configuration!
    previous_adapter = ActiveJob::Base.queue_adapter
    ActiveJob::Base.queue_adapter = :test
    example.run
    ActiveJob::Base.queue_adapter = previous_adapter
    EZAgentRails.reset_configuration!
  end

  before do
    EZAgentRails.configure do |c|
      c.default_provider = :fake
      c.default_model = "fake-1"
    end
  end

  let(:conversation) { EZAgentRails::Conversation.create! }

  it "enqueues a RunJob and returns the subscribe frame for HTML" do
    expect do
      post "/ez_agent/conversations/#{conversation.id}/runs", params: { prompt: "hi" }
    end.to have_enqueued_job(EZAgentRails::RunJob)

    expect(response).to have_http_status(:ok)

    run = conversation.runs.last
    expect(run).to be_present
    expect(run.provider).to eq("fake")
    expect(run.model).to eq("fake-1")

    # turbo_stream_from renders a <turbo-cable-stream-source> subscription tag and
    # the run's container carries its dom_id.
    expect(response.body).to include("turbo-cable-stream-source")
    expect(response.body).to include(ActionView::RecordIdentifier.dom_id(run))
  end

  it "returns run JSON (incl. the raw event stream name) for API clients" do
    post "/ez_agent/conversations/#{conversation.id}/runs",
         params: { prompt: "hi" }, as: :json

    expect(response).to have_http_status(:created)

    run = conversation.runs.last
    body = JSON.parse(response.body)
    expect(body["id"]).to eq(run.id)
    expect(body["status"]).to eq("running")
    expect(body["stream_name"]).to eq(EZAgentRails::RunChannel.stream_name_for(run))
  end

  it "shows an existing run as JSON" do
    run = conversation.runs.create!(provider: "fake", model: "fake-1")

    get "/ez_agent/runs/#{run.id}", as: :json

    expect(response).to have_http_status(:ok)
    expect(JSON.parse(response.body)["id"]).to eq(run.id)
  end

  it "renders outstanding confirmation cards on the run's HTML page" do
    run = conversation.runs.create!(provider: "fake", model: "fake-1")
    confirmation = run.tool_confirmations.create!(tool_name: "danger_write", args: { "path" => "x" })

    get "/ez_agent/runs/#{run.id}"

    expect(response).to have_http_status(:ok)
    expect(response.body).to include("danger_write")
    # The Approve button POSTs the user's decision to the engine endpoint.
    expect(response.body).to include("/ez_agent/confirmations/#{confirmation.id}")
    expect(response.body).to include("Approve")
  end
end
