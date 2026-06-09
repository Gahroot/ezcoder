# frozen_string_literal: true

RSpec.describe EZAgent do
  it "has a version" do
    expect(EZAgent::VERSION).to match(/\A\d+\.\d+\.\d+/)
  end

  it "depends on ez_llm and can see its constants" do
    expect(defined?(EZLLM)).to eq("constant")
    expect(EZLLM::ModelRegistry.default_model(:anthropic).id).to eq("claude-sonnet-4-6")
  end

  describe EZAgent::Result do
    it "extracts final text and reasoning" do
      result = described_class.new(
        message: { role: "assistant", content: [
          { type: "thinking", text: "hmm" }, { type: "text", text: "done" }
        ] },
        total_turns: 2, total_usage: EZLLM::Usage.new(input_tokens: 10)
      )
      expect(result.final_text).to eq("done")
      expect(result.final_reasoning).to eq("hmm")
    end
  end
end
