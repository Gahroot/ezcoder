# frozen_string_literal: true

require "support/fake_http_server"

RSpec.describe EZLLM::Providers::Anthropic do
  def event(name, data)
    "event: #{name}\ndata: #{JSON.generate(data)}\n\n"
  end

  it "streams thinking, text, and a tool call from the content_block protocol" do
    body = [
      event("message_start", { type: "message_start", message: { usage: { input_tokens: 20, cache_read_input_tokens: 5 } } }),
      event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
      event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "let me think" } }),
      event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }),
      event("content_block_stop", { type: "content_block_stop", index: 0 }),
      event("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text" } }),
      event("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hi there" } }),
      event("content_block_stop", { type: "content_block_stop", index: 1 }),
      event("content_block_start", { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "lookup" } }),
      event("content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"q":"x"}' } }),
      event("content_block_stop", { type: "content_block_stop", index: 2 }),
      event("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } })
    ].join
    server = FakeHTTPServer.new(headers: { "content-type" => "text/event-stream" }, body: body, chunked: true)
    events = []
    begin
      request = EZLLM::Request.new(provider: :anthropic, model: "claude-sonnet-4-6", api_key: "k",
                                   base_url: server.base_url, messages: [{ role: "user", content: "hi" }])
      response = described_class.call(request) { |e| events << e }
    ensure
      server.stop
    end

    expect(events.select { |e| e.type == :thinking_delta }.map(&:text).join).to include("let me think")
    expect(events.select { |e| e.type == :text_delta }.map(&:text).join).to eq("Hi there")
    done = events.find { |e| e.type == :toolcall_done }
    expect(done.name).to eq("lookup")
    expect(done.args).to eq("q" => "x")
    expect(response.stop_reason).to eq("tool_use")
    expect(response.usage.input_tokens).to eq(20)
    expect(response.usage.cache_read).to eq(5)
    expect(response.usage.output_tokens).to eq(30)
  end

  it "sends x-api-key for a regular key and bearer for an OAuth token" do
    body = event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })
    server = FakeHTTPServer.new(headers: { "content-type" => "text/event-stream" }, body: body, chunked: true)
    begin
      request = EZLLM::Request.new(provider: :anthropic, model: "claude-sonnet-4-6", api_key: "sk-ant-oat-xyz",
                                   base_url: server.base_url, messages: [{ role: "user", content: "hi" }])
      described_class.call(request) { |_| }
      sent = server.requests.first
    ensure
      server.stop
    end
    expect(sent[:headers]["authorization"]).to eq("Bearer sk-ant-oat-xyz")
    expect(sent[:headers]["anthropic-beta"]).to include("oauth-2025-04-20")
  end
end
