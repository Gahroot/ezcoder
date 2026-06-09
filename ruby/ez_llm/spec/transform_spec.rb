# frozen_string_literal: true

RSpec.describe EZLLM::Transform do
  describe ".to_openai_messages" do
    it "maps user, assistant tool_call, and tool result messages" do
      messages = [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        { role: "assistant", content: [
          { type: "text", text: "calling" },
          { type: "tool_call", id: "call_1", name: "get", args: { x: 1 } }
        ] },
        { role: "tool", content: [
          { type: "tool_result", tool_call_id: "call_1", content: "result text" }
        ] }
      ]
      out = described_class.to_openai_messages(messages)
      expect(out[0]).to eq(role: "system", content: "sys")
      expect(out[1]).to eq(role: "user", content: "hi")
      assistant = out[2]
      expect(assistant[:content]).to eq("calling")
      expect(assistant[:tool_calls].first[:function]).to eq(name: "get", arguments: '{"x":1}')
      expect(out[3]).to eq(role: "tool", tool_call_id: "call_1", content: "result text")
    end

    it "remaps Anthropic toolu_ ids to call_ ids consistently" do
      messages = [
        { role: "assistant", content: [{ type: "tool_call", id: "toolu_abc", name: "f", args: {} }] },
        { role: "tool", content: [{ type: "tool_result", tool_call_id: "toolu_abc", content: "ok" }] }
      ]
      out = described_class.to_openai_messages(messages)
      expect(out[0][:tool_calls].first[:id]).to eq("call_abc")
      expect(out[1][:tool_call_id]).to eq("call_abc")
    end
  end

  describe ".to_anthropic_messages" do
    it "splits system, preserves trajectory thinking, and pairs tool results" do
      messages = [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        { role: "assistant", content: [
          { type: "thinking", text: "reason", signature: "sig123" },
          { type: "tool_call", id: "toolu_1", name: "f", args: { a: 1 } }
        ] },
        { role: "tool", content: [{ type: "tool_result", tool_call_id: "toolu_1", content: "done", is_error: false }] }
      ]
      result = described_class.to_anthropic_messages(messages)
      expect(result[:system].first[:text]).to eq("sys")
      assistant = result[:messages].find { |m| m[:role] == "assistant" }
      expect(assistant[:content].map { |b| b[:type] }).to eq(%w[thinking tool_use])
      tool_msg = result[:messages].last
      expect(tool_msg[:content].first[:type]).to eq("tool_result")
      expect(tool_msg[:content].first[:tool_use_id]).to eq("toolu_1")
    end

    it "downgrades unsigned thinking to text" do
      messages = [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "thinking", text: "raw reason" }] }
      ]
      result = described_class.to_anthropic_messages(messages)
      assistant = result[:messages].find { |m| m[:role] == "assistant" }
      expect(assistant[:content]).to eq([{ type: "text", text: "raw reason" }])
    end
  end

  describe "capability downgrades" do
    it "replaces images with a placeholder when images are unsupported" do
      messages = [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", media_type: "image/png", data: "x" }] }]
      out = described_class.downgrade_unsupported_images(messages, false)
      expect(out.first[:content].map { |b| b[:type] }).to eq(%w[text text])
      expect(out.first[:content].last[:text]).to match(/image omitted/)
    end
  end

  describe ".normalize_openai_stop_reason / .normalize_anthropic_stop_reason" do
    it "maps provider reasons to the neutral set" do
      expect(described_class.normalize_openai_stop_reason("tool_calls")).to eq("tool_use")
      expect(described_class.normalize_openai_stop_reason("length")).to eq("max_tokens")
      expect(described_class.normalize_anthropic_stop_reason("pause_turn")).to eq("pause_turn")
    end
  end
end
