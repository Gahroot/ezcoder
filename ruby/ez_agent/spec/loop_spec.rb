# frozen_string_literal: true

require "support/fake_provider"

class AddTool < EZAgent::Tool
  description "Adds two numbers."
  param :a, :integer, required: true
  param :b, :integer, required: true
  def perform(a:, b:) = (a + b).to_s
end

RSpec.describe EZAgent::Loop do
  before do
    FakeProvider.reset!
    FakeProvider.install!
  end

  def build_loop(**opts)
    described_class.new(provider: :fake, model: "fake-1", **opts)
  end

  it "streams text and returns a Result for a no-tool turn" do
    FakeProvider.text("Hello world")
    events = []
    result = build_loop.run(messages: [{ role: "user", content: "hi" }]) { |e| events << e }

    expect(events.select { |e| e.type == :text_delta }.map(&:text).join).to eq("Hello world")
    expect(events.last.type).to eq(:agent_done)
    expect(result.final_text).to eq("Hello world")
    expect(result.total_turns).to eq(1)
  end

  it "executes a tool call then continues to a final answer" do
    FakeProvider.tool_call(id: "c1", name: "add_tool", args: { "a" => 2, "b" => 3 })
    FakeProvider.text("The answer is 5")
    events = []
    result = build_loop(tools: [AddTool]).run(messages: [{ role: "user", content: "2+3?" }]) { |e| events << e }

    start = events.find { |e| e.type == :tool_call_start }
    finish = events.find { |e| e.type == :tool_call_end }
    expect(start.name).to eq("add_tool")
    expect(finish.result).to eq("5")
    expect(finish.is_error).to be(false)
    expect(result.final_text).to eq("The answer is 5")
    expect(result.total_turns).to eq(2)
  end

  it "assigns monotonic seq numbers to every event" do
    FakeProvider.text("x")
    seqs = []
    build_loop.run(messages: [{ role: "user", content: "hi" }]) { |e| seqs << e.seq }
    expect(seqs).to eq(seqs.sort)
    expect(seqs.first).to eq(0)
  end

  it "accumulates usage across turns" do
    FakeProvider.tool_call(id: "c1", name: "add_tool", args: { "a" => 1, "b" => 1 })
    FakeProvider.text("done")
    result = build_loop(tools: [AddTool]).run(messages: [{ role: "user", content: "go" }])
    expect(result.total_usage.input_tokens).to eq(3) # 2 (tool turn) + 1 (final)
  end
end
