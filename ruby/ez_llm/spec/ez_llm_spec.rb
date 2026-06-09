# frozen_string_literal: true

RSpec.describe EZLLM do
  it "has a version" do
    expect(EZLLM::VERSION).to match(/\A\d+\.\d+\.\d+/)
  end

  it "eager-loads without errors" do
    expect { EZLLM.eager_load! }.not_to raise_error
  end

  it "raises a clean error for an unknown provider" do
    expect do
      EZLLM.stream(provider: :nope, model: "x", messages: [{ role: "user", content: "hi" }])
    end.to raise_error(EZLLM::Error, /Unknown provider/)
  end
end
