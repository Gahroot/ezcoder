# frozen_string_literal: true

RSpec.describe EZLLM::ModelRegistry do
  it "registers a model for every supported provider" do
    providers = described_class.all.map(&:provider).uniq
    expect(providers).to match_array(EZLLM::Types::PROVIDERS)
  end

  it "looks up by id and provider" do
    expect(described_class.get("claude-sonnet-4-6").name).to eq("Claude Sonnet 4.6")
    expect(described_class.for_provider(:glm).map(&:id)).to include("glm-5.1")
  end

  it "returns provider defaults" do
    expect(described_class.default_model(:anthropic).id).to eq("claude-sonnet-4-6")
    expect(described_class.default_model(:openai).id).to eq("gpt-5.5")
  end

  it "uses the codex context window only for OpenAI OAuth (accountId) calls" do
    expect(described_class.context_window("gpt-5.5", provider: :openai)).to eq(1_050_000)
    expect(described_class.context_window("gpt-5.5", provider: :openai, account_id: "acct_1")).to eq(272_000)
  end

  it "reports a video byte limit only for video models" do
    expect(described_class.video_byte_limit("kimi-k2.6")).to eq(100 * 1024 * 1024)
    expect(described_class.video_byte_limit("glm-5.1")).to be_nil
  end
end
