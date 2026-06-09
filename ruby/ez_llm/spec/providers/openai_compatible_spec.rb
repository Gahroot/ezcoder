# frozen_string_literal: true

require "support/fake_http_server"

RSpec.describe EZLLM::Providers::OpenAICompatible do
  def sse(*chunks)
    chunks.map { |c| "data: #{c.is_a?(String) ? c : JSON.generate(c)}\n\n" }.join
  end

  it "streams text and a tool call end-to-end over real HTTP + SSE" do
    body = sse(
      { choices: [{ index: 0, delta: { content: "Hel" } }] },
      { choices: [{ index: 0, delta: { content: "lo" } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather", arguments: '{"city":' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Tokyo"}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 12, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } } },
      "[DONE]"
    )
    server = FakeHTTPServer.new(headers: { "content-type" => "text/event-stream" }, body: body, chunked: true)
    events = []
    begin
      request = EZLLM::Request.new(provider: :glm, model: "glm-5.1", api_key: "k", base_url: server.base_url,
                                   messages: [{ role: "user", content: "weather?" }])
      response = described_class.call(request) { |e| events << e }
    ensure
      server.stop
    end

    expect(events.select { |e| e.type == :text_delta }.map(&:text).join).to eq("Hello")
    done = events.find { |e| e.type == :toolcall_done }
    expect(done.name).to eq("get_weather")
    expect(done.args).to eq("city" => "Tokyo")
    expect(response.stop_reason).to eq("tool_use")
    # inputTokens excludes the 2 cached tokens (12 - 2)
    expect(response.usage.input_tokens).to eq(10)
    expect(response.usage.cache_read).to eq(2)
    assistant = response.message[:content]
    expect(assistant.map { |b| b[:type] }).to eq(%w[text tool_call])
  end

  it "sends the GLM thinking param and bearer auth header" do
    body = sse({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }, "[DONE]")
    server = FakeHTTPServer.new(headers: { "content-type" => "text/event-stream" }, body: body, chunked: true)
    begin
      request = EZLLM::Request.new(provider: :glm, model: "glm-5.1", api_key: "secret", base_url: server.base_url,
                                   thinking: :high, messages: [{ role: "user", content: "hi" }])
      described_class.call(request) { |_| }
      sent = server.requests.first
    ensure
      server.stop
    end
    expect(sent[:headers]["authorization"]).to eq("Bearer secret")
    payload = JSON.parse(sent[:body])
    expect(payload["thinking"]).to eq("type" => "enabled")
  end

  it "classifies a 402 response as a hard billing ProviderError" do
    server = FakeHTTPServer.new(status: 402, body: JSON.generate(error: { message: "insufficient balance" }))
    begin
      request = EZLLM::Request.new(provider: :deepseek, model: "deepseek-v4-pro", api_key: "k", base_url: server.base_url,
                                   messages: [{ role: "user", content: "hi" }])
      expect do
        described_class.call(request) { |_| }
      end.to raise_error(EZLLM::ProviderError) do |err|
        expect(err.status_code).to eq(402)
        expect(EZLLM::Errors.billing?(err)).to be(true)
        expect(err.message).to match(/usage limit reached/)
      end
    ensure
      server.stop
    end
  end

  it "supports the non-streaming buffered fallback" do
    completion = { choices: [{ message: { content: "buffered reply" }, finish_reason: "stop" }],
                   usage: { prompt_tokens: 4, completion_tokens: 3 } }
    server = FakeHTTPServer.new(headers: { "content-type" => "application/json" }, body: JSON.generate(completion))
    events = []
    begin
      request = EZLLM::Request.new(provider: :openai, model: "gpt-5.5", api_key: "k", base_url: server.base_url,
                                   streaming: false, messages: [{ role: "user", content: "hi" }])
      response = described_class.call(request) { |e| events << e }
    ensure
      server.stop
    end
    expect(events.select { |e| e.type == :text_delta }.map(&:text).join).to eq("buffered reply")
    expect(response.message[:content].first[:text]).to eq("buffered reply")
  end
end
