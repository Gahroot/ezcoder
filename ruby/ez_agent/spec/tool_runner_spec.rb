# frozen_string_literal: true

RSpec.describe EZAgent::ToolRunner do
  def registry(*tools)
    EZAgent::ToolRegistry.new(tools)
  end

  class EchoTool < EZAgent::Tool
    description "echo"
    param :text, :string, required: true
    def perform(text:) = "echo: #{text}"
  end

  class BoomTool < EZAgent::Tool
    description "raises"
    param :x, :string, required: true
    def perform(x:) = raise("kaboom #{x}")
  end

  class SlowTool < EZAgent::Tool
    description "slow"
    def perform = sleep(5)
  end

  class StructuredTool < EZAgent::Tool
    description "structured"
    def perform = { content: "body", details: { rows: 3 } }
  end

  it "returns the tool output on success" do
    runner = described_class.new(registry: registry(EchoTool))
    outcome = runner.run({ id: "1", name: "echo_tool", args: { "text" => "hi" } })
    expect(outcome.content).to eq("echo: hi")
    expect(outcome.is_error).to be(false)
    expect(outcome.classification).to eq(:ok)
  end

  it "isolates faults into a structured error result instead of raising" do
    runner = described_class.new(registry: registry(BoomTool))
    outcome = runner.run({ id: "2", name: "boom_tool", args: { "x" => "1" } })
    expect(outcome.is_error).to be(true)
    expect(outcome.classification).to eq(:error)
    expect(JSON.parse(outcome.content)).to eq("error" => "kaboom 1")
  end

  it "reports unknown tools" do
    runner = described_class.new(registry: registry(EchoTool))
    outcome = runner.run({ id: "3", name: "nope", args: {} })
    expect(outcome.classification).to eq(:unknown_tool)
  end

  it "rejects invalid arguments before executing" do
    runner = described_class.new(registry: registry(EchoTool))
    outcome = runner.run({ id: "4", name: "echo_tool", args: { "text" => 123 } })
    expect(outcome.classification).to eq(:invalid_args)
    expect(outcome.content).to match(/expected string/)
  end

  it "enforces a per-tool timeout" do
    runner = described_class.new(registry: registry(SlowTool), timeout_seconds: 0.1)
    outcome = runner.run({ id: "5", name: "slow_tool", args: {} })
    expect(outcome.classification).to eq(:timeout)
  end

  it "normalizes structured results with details" do
    runner = described_class.new(registry: registry(StructuredTool))
    outcome = runner.run({ id: "6", name: "structured_tool", args: {} })
    expect(outcome.content).to eq("body")
    expect(outcome.details).to eq(rows: 3)
  end

  it "redacts sensitive args in logs" do
    logged = []
    runner = described_class.new(registry: registry(EchoTool), logger: ->(e, d) { logged << [e, d] })
    runner.run({ id: "7", name: "echo_tool", args: { "text" => "hi", "api_key" => "secret" } })
    start = logged.find { |e, _| e == :tool_start }.last
    expect(start[:args]["api_key"]).to eq("[redacted]")
  end
end

RSpec.describe EZAgent::Truncation do
  it "caps oversized content with head/tail preservation" do
    text = "A" * 1000 + "ZZZ"
    capped = described_class.cap(text, 100)
    expect(capped.length).to be < text.length
    expect(capped).to start_with("A")
    expect(capped).to end_with("ZZZ")
    expect(capped).to include("characters omitted")
  end

  it "leaves small content untouched" do
    expect(described_class.cap("short", 100)).to eq("short")
  end
end
