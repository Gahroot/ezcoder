# frozen_string_literal: true

require "rails_helper"

# End-to-end proof that the whole adapter works inside the dummy Rails app: the
# bundled demo controllers/views create a conversation and submit a prompt, the
# RunJob drives a REAL {EZAgent::Loop} against the in-process scripted provider
# (no network), the demo's example {EZAgentRails::Demo::GetWeather} tool actually
# runs, and the streamed assistant text + the tool result are persisted while the
# run finishes `succeeded`.
RSpec.describe "EZAgentRails demo chat", type: :request do
  include ActiveJob::TestHelper

  around do |example|
    EZAgentRails.reset_configuration!
    FakeProvider.reset!
    FakeProvider.install!
    previous_adapter = ActiveJob::Base.queue_adapter
    ActiveJob::Base.queue_adapter = :test
    example.run
    ActiveJob::Base.queue_adapter = previous_adapter
    EZAgentRails.reset_configuration!
    FakeProvider.reset!
  end

  before do
    EZAgentRails.configure do |c|
      c.default_provider = :fake
      c.default_model = "fake-1"
      c.credentials_resolver = ->(_provider, _context) { { api_key: "test-key" } }
      c.tools = [EZAgentRails::Demo::GetWeather]
    end

    # RSpec doesn't run the Minitest lifecycle hooks that install Action Cable's
    # test pubsub, so swap it in for the Broadcaster's broadcasts.
    @previous_pubsub = ActionCable.server.pubsub
    ActionCable.server.instance_variable_set(
      :@pubsub, ActionCable::SubscriptionAdapter::Test.new(ActionCable.server)
    )
  end

  after do
    ActionCable.server.instance_variable_set(:@pubsub, @previous_pubsub)
  end

  it "renders the demo chat page with a prompt form and the Turbo runtime" do
    conversation = EZAgentRails::Conversation.create!(title: "Weather chat")

    get "/ez_agent/conversations/#{conversation.id}"

    expect(response).to have_http_status(:ok)
    expect(response.body).to include("Weather chat")
    # The prompt form posts to RunsController#create, targeting the active-run frame.
    expect(response.body).to include("/ez_agent/conversations/#{conversation.id}/runs")
    expect(response.body).to include('turbo-frame id="ez_agent_active_run"')
    # The bundled Turbo runtime is loaded (no JS build step).
    expect(response.body).to include("/ez_agent/turbo.js")
  end

  it "creates a conversation, submits a prompt, runs the job, and persists the streamed text + tool result" do
    # Turn 1: the model calls the demo weather tool. Turn 2: it answers.
    FakeProvider.tool_call(id: "w1", name: "get_weather", args: { "city" => "Tokyo" },
                           text: "Let me check the weather.")
    FakeProvider.text("It is clear in Tokyo right now.")

    # Start a new conversation through the demo controller.
    post "/ez_agent/conversations", params: { conversation: { title: "Demo" } }
    expect(response).to have_http_status(:found)
    conversation = EZAgentRails::Conversation.order(:id).last
    expect(conversation).to be_present

    # Submit the prompt; run the enqueued RunJob inline.
    perform_enqueued_jobs do
      post "/ez_agent/conversations/#{conversation.id}/runs", params: { prompt: "weather in Tokyo?" }
    end
    expect(response).to have_http_status(:ok)
    # The create response is the active-run frame the prompt form swaps in.
    expect(response.body).to include('turbo-frame id="ez_agent_active_run"')
    expect(response.body).to include("turbo-cable-stream-source")

    conversation.reload
    run = conversation.runs.last

    # (a) the run finished cleanly
    expect(run).to be_succeeded
    expect(run.error_message).to be_nil

    # (b) the user prompt + final streamed assistant text are persisted
    expect(conversation.messages.where(role: "user").last.content).to eq("weather in Tokyo?")
    assistant = conversation.messages.where(role: "assistant").last
    final_text = assistant.to_llm_message[:content]
                          .select { |b| b[:type] == "text" }
                          .map { |b| b[:text] }.join
    expect(final_text).to eq("It is clear in Tokyo right now.")

    # (c) the demo tool actually ran and its result is persisted as a tool message
    tool_message = conversation.messages.where(role: "tool").last
    expect(tool_message).to be_present
    tool_block = tool_message.to_llm_message[:content].first
    expect(tool_block[:type]).to eq("tool_result")
    expect(tool_block[:tool_call_id]).to eq("w1")
    expect(EZLLM::Types.tool_result_text(tool_block[:content])).to include("Weather in Tokyo: 18°C")

    # (d) reloading the chat page renders the persisted tool call + answer
    get "/ez_agent/conversations/#{conversation.id}"
    expect(response.body).to include("Weather in Tokyo: 18°C")
    expect(response.body).to include("It is clear in Tokyo right now.")
  end

  it "serves Turbo's runtime from the engine so the demo needs no JS build step" do
    get "/ez_agent/turbo.js"

    expect(response).to have_http_status(:ok)
    expect(response.media_type).to eq("text/javascript")
    expect(response.body).to include("Turbo")
  end
end
