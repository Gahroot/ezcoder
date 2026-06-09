# frozen_string_literal: true

require "rails_helper"

RSpec.describe EZAgentRails::Run, type: :model do
  let(:conversation) { EZAgentRails::Conversation.create! }

  it "defaults to the running status" do
    run = conversation.runs.create!(provider: "anthropic", model: "claude")
    expect(run).to be_running
  end

  it "exposes the status enum transitions" do
    run = conversation.runs.create!(provider: "anthropic", model: "claude")
    run.succeeded!
    expect(run.reload.status).to eq("succeeded")
    expect(described_class.statuses.keys).to contain_exactly("running", "succeeded", "failed", "aborted")
  end

  describe "#record_result" do
    it "captures usage (input + cache) and marks the run succeeded" do
      usage = EZLLM::Usage.new(input_tokens: 100, output_tokens: 40, cache_read: 10, cache_write: 5)
      result = EZAgent::Result.new(
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        total_turns: 2,
        total_usage: usage
      )
      run = conversation.runs.create!(provider: "anthropic", model: "claude")

      run.record_result(result)
      run.reload

      expect(run).to be_succeeded
      expect(run.input_tokens).to eq(115)
      expect(run.output_tokens).to eq(40)
    end
  end

  describe "#record_failure" do
    it "stores the error message and marks the run failed" do
      run = conversation.runs.create!(provider: "anthropic", model: "claude")
      run.record_failure(StandardError.new("boom"))

      expect(run.reload).to be_failed
      expect(run.error_message).to eq("boom")
    end
  end
end
