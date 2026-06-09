# frozen_string_literal: true

require "rails_helper"

# A trivial tool so the scripted loop can produce real tool_call_start /
# tool_call_end events for the Broadcaster to map.
class SumTool < EZAgent::Tool
  description "Adds two numbers."
  param :a, :integer, required: true
  param :b, :integer, required: true
  def perform(a:, b:) = (a + b).to_s
end

RSpec.describe EZAgentRails::Broadcaster do
  include_context "with scripted streaming"

  let(:conversation) { EZAgentRails::Conversation.create! }
  let(:run) { conversation.runs.create!(provider: "fake", model: "fake-1") }

  def drive_loop(broadcaster, tools: [])
    EZAgent::Loop.new(provider: :fake, model: "fake-1", tools: tools).run(
      messages: [{ role: "user", content: "go" }],
      credentials: { api_key: "x" },
      &broadcaster
    )
  end

  it "appends streamed text to the stream target and replaces the status on done" do
    FakeProvider.text("streamed words")

    drive_loop(EZAgentRails::Broadcaster.new(run))
    turbo = capture_turbo_stream_broadcasts(run)

    append = turbo.find do |el|
      el["action"] == "append" && el["target"] == EZAgentRails::DomTargets.stream(run)
    end
    expect(append).to be_present
    expect(append.to_s).to include("streamed words")

    status = turbo.find do |el|
      el["action"] == "replace" && el["target"] == EZAgentRails::DomTargets.status(run)
    end
    expect(status).to be_present
    expect(status.to_s).to include("Completed")
  end

  it "renders a tool call as an appended frame then replaces it when it ends" do
    FakeProvider.tool_call(id: "c1", name: "sum_tool", args: { "a" => 1, "b" => 2 })
    FakeProvider.text("the answer is 3")

    drive_loop(EZAgentRails::Broadcaster.new(run), tools: [SumTool])
    turbo = capture_turbo_stream_broadcasts(run)

    start_frame = turbo.find do |el|
      el["action"] == "append" && el["target"] == EZAgentRails::DomTargets.tools(run)
    end
    expect(start_frame).to be_present
    expect(start_frame.to_s).to include("sum_tool")

    end_frame = turbo.find do |el|
      el["action"] == "replace" &&
        el["target"] == EZAgentRails::DomTargets.tool_frame(run, "c1")
    end
    expect(end_frame).to be_present
    expect(end_frame.to_s).to include("3")        # the tool result
    expect(end_frame.to_s).to include("sum_tool") # labelled with the remembered name
  end

  it "appends an actionable confirm card then replaces it when resolved" do
    confirmation = run.tool_confirmations.create!(
      tool_name: "danger_write", args: { "path" => "report.txt" }, tool_call_id: "c1"
    )
    broadcaster = EZAgentRails::Broadcaster.new(run)

    broadcaster.confirm_request(confirmation)
    broadcaster.confirm_resolved(confirmation.tap { |c| c.update!(status: "deny") })
    turbo = capture_turbo_stream_broadcasts(run)

    frame_target = EZAgentRails::DomTargets.confirmation_frame(run, confirmation.id)

    appended = turbo.find do |el|
      el["action"] == "append" && el["target"] == EZAgentRails::DomTargets.tools(run)
    end
    expect(appended).to be_present
    # Approve / Deny / Always buttons POST to the engine's confirmations endpoint.
    expect(appended.to_s).to include("danger_write")
    expect(appended.to_s).to include("/ez_agent/confirmations/#{confirmation.id}")
    expect(appended.to_s).to include("Approve").and include("Deny").and include("Always")

    resolved = turbo.find do |el|
      el["action"] == "replace" && el["target"] == frame_target
    end
    expect(resolved).to be_present
    # Resolved card drops the action buttons.
    expect(resolved.to_s).not_to include("Approve")
  end

  it "publishes the same events as raw JSON on the RunChannel fallback stream" do
    FakeProvider.tool_call(id: "c1", name: "sum_tool", args: { "a" => 2, "b" => 2 })
    FakeProvider.text("done")

    drive_loop(EZAgentRails::Broadcaster.new(run), tools: [SumTool])

    payloads = raw_broadcasts(EZAgentRails::RunChannel.stream_name_for(run))
    types = payloads.map { |p| p["type"] }
    expect(types).to include("text_delta", "tool_call_start", "tool_call_end", "agent_done")

    done = payloads.find { |p| p["type"] == "agent_done" }
    expect(done["total_turns"]).to eq(2)
    expect(done.dig("total_usage", "output_tokens")).to be >= 1

    every_event_has_seq = payloads.all? { |p| p.key?("seq") }
    expect(every_event_has_seq).to be(true)
  end
end
