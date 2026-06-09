# frozen_string_literal: true

require "rails_helper"

RSpec.describe EZAgentRails::Configuration do
  around do |example|
    EZAgentRails.reset_configuration!
    example.run
    EZAgentRails.reset_configuration!
  end

  it "exposes sane defaults" do
    config = described_class.new
    expect(config.default_provider).to eq(:anthropic)
    expect(config.default_model).to be_a(String)
    expect(config.tools).to eq([])
    expect(config.fence_untrusted).to be(false)
    expect(config.approval_enabled).to be(false)
    expect(config.credentials_resolver).to respond_to(:call)
  end

  it "is mutated through EZAgentRails.configure" do
    EZAgentRails.configure do |c|
      c.default_provider = :openai
      c.default_model = "gpt-x"
      c.fence_untrusted = true
    end

    expect(EZAgentRails.configuration.default_provider).to eq(:openai)
    expect(EZAgentRails.configuration.default_model).to eq("gpt-x")
    expect(EZAgentRails.configuration.fence_untrusted).to be(true)
  end

  describe ".credentials_for" do
    it "reads the api key from ENV via the default resolver" do
      ENV["ANTHROPIC_API_KEY"] = "sk-test-123"
      creds = EZAgentRails.credentials_for(:anthropic)
      expect(creds[:api_key]).to eq("sk-test-123")
    ensure
      ENV.delete("ANTHROPIC_API_KEY")
    end

    it "honors a custom resolver with provider + context" do
      EZAgentRails.configure do |c|
        c.credentials_resolver = ->(provider, context) { { api_key: "#{provider}:#{context}" } }
      end

      expect(EZAgentRails.credentials_for(:openai, context: "acct_9"))
        .to eq(api_key: "openai:acct_9")
    end
  end
end
