# frozen_string_literal: true

RSpec.describe EZAgent::Cancellation do
  it "starts un-aborted and flips on abort!" do
    token = described_class.new
    expect(token.aborted?).to be(false)
    token.abort!
    expect(token.aborted?).to be(true)
  end

  it "raises Aborted from check! once aborted" do
    token = described_class.new
    expect { token.check! }.not_to raise_error
    token.abort!
    expect { token.check! }.to raise_error(EZAgent::Cancellation::Aborted)
  end

  it "fires on_abort callbacks once, and immediately if already aborted" do
    token = described_class.new
    fired = 0
    token.on_abort { fired += 1 }
    token.abort!
    token.abort! # idempotent
    expect(fired).to eq(1)

    later = 0
    token.on_abort { later += 1 }
    expect(later).to eq(1) # registered after abort → fires immediately
  end

  it "swallows callback errors so abort! never raises" do
    token = described_class.new
    token.on_abort { raise "boom" }
    expect { token.abort! }.not_to raise_error
  end
end
