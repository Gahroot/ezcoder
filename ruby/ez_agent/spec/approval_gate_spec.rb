# frozen_string_literal: true

require "support/fake_provider"

class PublishTool < EZAgent::Tool
  description "Publishes a post."
  requires_confirmation!
  param :text, :string, required: true
  def perform(text:) = "published: #{text}"
end

RSpec.describe EZAgent::ToolPolicy do
  it "gates tools by explicit name or the requires_confirmation! macro" do
    policy = described_class.new(requires_confirmation: %w[send_email])
    expect(policy.requires_confirmation?("send_email")).to be(true)
    expect(policy.requires_confirmation?("publish_tool", PublishTool.new)).to be(true)
    expect(policy.requires_confirmation?("read_only")).to be(false)
  end
end

RSpec.describe EZAgent::ApprovalGate do
  it "returns the decide callable's decision" do
    gate = described_class.new(decide: ->(_req) { :deny })
    expect(gate.request(name: "x", args: {})).to eq(:deny)
  end

  it "makes always_allow sticky for the run" do
    calls = 0
    gate = described_class.new(decide: lambda do |_req|
      calls += 1
      :always_allow
    end)
    expect(gate.request(name: "publish", args: {})).to eq(:allow)
    expect(gate.request(name: "publish", args: {})).to eq(:allow)
    expect(calls).to eq(1) # second call short-circuits via allow-list
  end

  it "decides deterministically in cron mode without a user" do
    deny_gate = described_class.new(mode: :cron, auto_confirm: false)
    allow_gate = described_class.new(mode: :cron, auto_confirm: true)
    expect(deny_gate.request(name: "x", args: {})).to eq(:deny)
    expect(allow_gate.request(name: "x", args: {})).to eq(:allow)
  end
end

RSpec.describe "Loop with approval gate" do
  before do
    FakeProvider.reset!
    FakeProvider.install!
  end

  def build_loop(approval:)
    EZAgent::Loop.new(provider: :fake, model: "fake-1", tools: [PublishTool], approval: approval)
  end

  it "denies a gated tool and feeds the denial back to the model" do
    FakeProvider.tool_call(id: "c1", name: "publish_tool", args: { "text" => "hi" })
    FakeProvider.text("Okay, I won't publish.")
    gate = EZAgent::ApprovalGate.new(decide: ->(_req) { :deny })
    events = []
    result = build_loop(approval: gate).run(messages: [{ role: "user", content: "publish hi" }]) { |e| events << e }

    expect(events.map(&:type)).to include(:tool_confirm_request)
    end_event = events.find { |e| e.type == :tool_call_end }
    expect(end_event).to be_nil # tool never ran
    expect(result.final_text).to eq("Okay, I won't publish.")
  end

  it "does not re-prompt after always_allow" do
    FakeProvider.tool_call(id: "c1", name: "publish_tool", args: { "text" => "one" })
    FakeProvider.tool_call(id: "c2", name: "publish_tool", args: { "text" => "two" })
    FakeProvider.text("done")
    gate = EZAgent::ApprovalGate.new(decide: ->(_req) { :always_allow })
    confirms = []
    build_loop(approval: gate).run(messages: [{ role: "user", content: "publish twice" }]) do |e|
      confirms << e if e.type == :tool_confirm_request
    end
    # Only the first call prompts; the second is auto-allowed silently.
    expect(confirms.length).to eq(1)
  end

  it "allows a gated tool when approved" do
    FakeProvider.tool_call(id: "c1", name: "publish_tool", args: { "text" => "hi" })
    FakeProvider.text("Published!")
    gate = EZAgent::ApprovalGate.new(decide: ->(_req) { :allow })
    events = []
    build_loop(approval: gate).run(messages: [{ role: "user", content: "publish hi" }]) { |e| events << e }

    end_event = events.find { |e| e.type == :tool_call_end }
    expect(end_event.result).to eq("published: hi")
  end
end
