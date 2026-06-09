# frozen_string_literal: true

RSpec.describe EZLLM::Errors do
  describe ".hard_billing_message?" do
    it "matches credit/quota exhaustion phrases case-insensitively" do
      expect(described_class.hard_billing_message?("Insufficient Balance")).to be(true)
      expect(described_class.hard_billing_message?("exceeded your current quota")).to be(true)
      expect(described_class.hard_billing_message?("all good")).to be(false)
    end
  end

  describe ".billing?" do
    it "treats HTTP 402 as a hard billing stop" do
      err = EZLLM::ProviderError.new("deepseek", "nope", status_code: 402)
      expect(described_class.billing?(err)).to be(true)
    end
  end

  describe ".classify_overload" do
    it "maps 429 to rate_limit and 529 to overloaded" do
      expect(described_class.classify_overload(EZLLM::ProviderError.new("openai", "rate limit", status_code: 429))).to eq(:rate_limit)
      expect(described_class.classify_overload(EZLLM::ProviderError.new("anthropic", "overloaded", status_code: 529))).to eq(:overloaded)
    end

    it "never retries billing or usage-limit errors" do
      expect(described_class.classify_overload(EZLLM::ProviderError.new("glm", "usage limit reached", status_code: 429))).to be_nil
      expect(described_class.classify_overload(EZLLM::ProviderError.new("glm", "insufficient balance", status_code: 429))).to be_nil
    end
  end

  describe ".context_overflow?" do
    it "detects overflow but excludes 402 credit errors" do
      expect(described_class.context_overflow?(StandardError.new("prompt is too long"))).to be(true)
      expect(described_class.context_overflow?(EZLLM::ProviderError.new("x", "203456 tokens > 200000 maximum", status_code: 402))).to be(false)
    end
  end

  describe ".context_overflow_details" do
    it "extracts observed tokens and limit" do
      details = described_class.context_overflow_details(StandardError.new("203,456 tokens > 200000 maximum"))
      expect(details).to eq(observed_tokens: 203_456, observed_limit: 200_000)
    end
  end

  describe ".tool_pairing?" do
    it "detects orphaned tool_use/tool_result errors" do
      expect(described_class.tool_pairing?(StandardError.new("tool_use ids found without tool_result"))).to be(true)
      expect(described_class.tool_pairing?(StandardError.new("tool call id abc is not found"))).to be(true)
    end
  end

  describe ".format_error_for_display" do
    it "renders a provider error with headline and guidance" do
      out = described_class.format_error_for_display(EZLLM::ProviderError.new("openai", "overloaded", status_code: 529))
      expect(out).to include("OpenAI returned an error.")
      expect(out).to include("→")
    end
  end
end
