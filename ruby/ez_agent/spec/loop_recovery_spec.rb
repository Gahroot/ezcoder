# frozen_string_literal: true

require "support/fake_provider"

RSpec.describe "EZAgent::Loop recovery paths" do
  before do
    FakeProvider.reset!
    FakeProvider.install!
  end

  # Tiny backoff so recovery tests don't actually sleep seconds.
  def build_loop(**opts)
    EZAgent::Loop.new(provider: :fake, model: "fake-1",
                      overload_base_delay_ms: 1, stall_delay_ms: 1, **opts)
  end

  it "retries on an overload error then succeeds" do
    FakeProvider.error(EZLLM::ProviderError.new("fake", "overloaded", status_code: 529))
    FakeProvider.text("recovered")
    retries = []
    result = build_loop.run(messages: [{ role: "user", content: "hi" }]) do |e|
      retries << e if e.type == :retry
    end
    expect(retries.first.reason).to eq(:overloaded)
    expect(result.final_text).to eq("recovered")
  end

  it "honors a server-stated reset delay on a rate limit" do
    err = EZLLM::ProviderError.new("fake", "rate limit", status_code: 429,
                                   resets_at: (Time.now.to_i + 0.05).to_i)
    FakeProvider.error(err)
    FakeProvider.text("ok")
    retries = []
    build_loop.run(messages: [{ role: "user", content: "hi" }]) { |e| retries << e if e.type == :retry }
    expect(retries.first.reason).to eq(:rate_limit)
  end

  it "retries empty responses up to the cap then finishes" do
    FakeProvider.empty
    FakeProvider.text("finally")
    retries = []
    result = build_loop.run(messages: [{ role: "user", content: "hi" }]) { |e| retries << e if e.type == :retry }
    expect(retries.map(&:reason)).to include(:empty_response)
    expect(result.final_text).to eq("finally")
  end

  it "flips to non-streaming fallback after repeated stalls" do
    3.times { FakeProvider.error(Errno::ECONNRESET.new("socket hang up")) }
    FakeProvider.text("back online")
    stalls = []
    result = build_loop.run(messages: [{ role: "user", content: "hi" }]) { |e| stalls << e if e.type == :retry }
    expect(stalls.map(&:reason)).to all(eq(:stream_stall))
    expect(stalls.length).to be >= 2
    expect(result.final_text).to eq("back online")
  end

  it "compacts on a context overflow when a transform is provided" do
    FakeProvider.error(EZLLM::ProviderError.new("fake", "prompt is too long: 210000 tokens > 200000 maximum"))
    FakeProvider.text("compacted ok")
    compactor = lambda do |messages, force|
      # Only reduce when the loop forces compaction (after the overflow error);
      # the pre-turn proactive pass (force=false) leaves history untouched.
      force ? [messages.last] : messages
    end
    events = []
    result = build_loop(transform_context: compactor)
             .run(messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }]) { |e| events << e }
    expect(events.map(&:type)).to include(:retry)
    expect(result.final_text).to eq("compacted ok")
  end

  it "repairs orphaned tool pairing and retries once" do
    FakeProvider.error(EZLLM::ProviderError.new("fake", "tool_use ids found without tool_result blocks", status_code: 400))
    FakeProvider.text("repaired")
    result = build_loop.run(messages: [{ role: "user", content: "hi" }])
    expect(result.final_text).to eq("repaired")
  end

  it "surfaces a usage-limit error without retrying" do
    FakeProvider.error(EZLLM::ProviderError.new("fake", "usage limit reached", status_code: 429))
    expect do
      build_loop.run(messages: [{ role: "user", content: "hi" }])
    end.to raise_error(EZLLM::ProviderError, /usage limit reached/)
  end
end

RSpec.describe "EZAgent::Loop cancellation" do
  before do
    FakeProvider.reset!
    FakeProvider.install!
  end

  it "stops before the next turn when the token is aborted" do
    cancel = EZAgent::Cancellation.new
    FakeProvider.tool_call(id: "c1", name: "noop", args: {})
    # Abort as soon as we see the first event.
    events = []
    loop = EZAgent::Loop.new(provider: :fake, model: "fake-1")
    result = loop.run(messages: [{ role: "user", content: "hi" }], cancellation: cancel) do |e|
      events << e
      cancel.abort! if e.type == :toolcall_delta || e.type == :turn_end
    end
    expect(result).to be_a(EZAgent::Result)
    expect(events.last.type).to eq(:agent_done)
  end
end
