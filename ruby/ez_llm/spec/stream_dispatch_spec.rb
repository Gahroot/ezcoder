# frozen_string_literal: true

require "support/fake_http_server"

RSpec.describe "EZLLM.stream dispatch" do
  def sse(*chunks)
    chunks.map { |c| "data: #{c.is_a?(String) ? c : JSON.generate(c)}\n\n" }.join
  end

  it "routes through the registry to the right provider and yields events" do
    body = sse({ choices: [{ index: 0, delta: { content: "routed" }, finish_reason: "stop" }] }, "[DONE]")
    server = FakeHTTPServer.new(headers: { "content-type" => "text/event-stream" }, body: body, chunked: true)
    texts = []
    begin
      response = EZLLM.stream(provider: :openrouter, model: "qwen/qwen3.6-plus", api_key: "k",
                              base_url: server.base_url, messages: [{ role: "user", content: "hi" }]) do |event|
        texts << event.text if event.type == :text_delta
      end
    ensure
      server.stop
    end
    expect(texts.join).to eq("routed")
    expect(response).to be_a(EZLLM::Response)
  end

  it "fails fast with a capability error when video is present but unsupported" do
    messages = [{ role: "user", content: [EZLLM::Types.video(media_type: "video/mp4", data: "AA==")] }]
    expect do
      EZLLM.stream(provider: :anthropic, model: "claude-sonnet-4-6", messages: messages)
    end.to raise_error(EZLLM::VideoUnsupportedError)
  end

  it "honors the non-streaming fallback through the public API" do
    completion = { choices: [{ message: { content: "no-stream" }, finish_reason: "stop" }],
                   usage: { prompt_tokens: 1, completion_tokens: 1 } }
    server = FakeHTTPServer.new(headers: { "content-type" => "application/json" }, body: JSON.generate(completion))
    texts = []
    begin
      EZLLM.stream(provider: :deepseek, model: "deepseek-v4-pro", api_key: "k", base_url: server.base_url,
                   streaming: false, messages: [{ role: "user", content: "hi" }]) do |event|
        texts << event.text if event.type == :text_delta
      end
    ensure
      server.stop
    end
    expect(texts.join).to eq("no-stream")
  end
end
