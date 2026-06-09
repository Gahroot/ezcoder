# frozen_string_literal: true

require "rails_helper"

RSpec.describe EZAgentRails::Conversation, type: :model do
  # A conversation that exercises every framework message shape: string content,
  # an assistant turn with thinking + text + a tool_call (nested args), and a
  # tool turn whose content is an array of tool_result blocks.
  let(:framework_messages) do
    [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "What's the weather in Paris?" },
      { role: "assistant", content: [
        { type: "thinking", text: "The user wants Paris weather." },
        { type: "text", text: "Let me check." },
        { type: "tool_call", id: "call_1", name: "get_weather",
          args: { city: "Paris", units: "metric", days: 1 } }
      ] },
      { role: "tool", content: [
        { type: "tool_result", tool_call_id: "call_1",
          content: "Sunny, 22C", is_error: false }
      ] },
      { role: "assistant", content: [
        { type: "text", text: "It's sunny and 22C in Paris." }
      ] }
    ]
  end

  describe "#append_message / #to_llm_messages" do
    it "round-trips the framework message Hash shape losslessly" do
      conversation = described_class.create!
      framework_messages.each { |m| conversation.append_message(m) }

      conversation.reload
      expect(conversation.to_llm_messages).to eq(framework_messages)
    end

    it "preserves order via position regardless of insertion timing" do
      conversation = described_class.create!
      conversation.append_messages(framework_messages)

      roles = described_class.find(conversation.id).to_llm_messages.map { |m| m[:role] }
      expect(roles).to eq(%w[system user assistant tool assistant])
    end

    it "accepts string-keyed message Hashes too" do
      conversation = described_class.create!
      conversation.append_message("role" => "user", "content" => "hi")

      expect(conversation.reload.to_llm_messages).to eq([{ role: "user", content: "hi" }])
    end

    it "round-trips nested data types (integers, booleans) inside content blocks" do
      conversation = described_class.create!
      message = { role: "assistant", content: [
        { type: "tool_call", id: "c1", name: "calc",
          args: { n: 42, flag: true, nested: { ok: false, list: [1, 2, 3] } } }
      ] }
      conversation.append_message(message)

      restored = conversation.reload.to_llm_messages.first
      args = restored.dig(:content, 0, :args)
      expect(args).to eq(n: 42, flag: true, nested: { ok: false, list: [1, 2, 3] })
    end
  end

  describe "associations" do
    it "destroys dependent messages and runs" do
      conversation = described_class.create!
      conversation.append_message(role: "user", content: "hi")
      conversation.runs.create!(provider: "anthropic", model: "claude")

      expect { conversation.destroy }
        .to change(EZAgentRails::Message, :count).by(-1)
        .and change(EZAgentRails::Run, :count).by(-1)
    end
  end
end
