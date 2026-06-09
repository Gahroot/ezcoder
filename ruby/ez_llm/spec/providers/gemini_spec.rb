# frozen_string_literal: true

require "support/fake_http_server"

RSpec.describe EZLLM::Providers::Gemini do
  def sse(*objs)
    objs.map { |o| "data: #{JSON.generate(o)}\n\n" }.join
  end

  it "streams text, thoughts, and a functionCall over SSE" do
    body = sse(
      { candidates: [{ content: { parts: [{ text: "thinking...", thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: "Answer" }] } }] },
      { candidates: [{ content: { parts: [{ functionCall: { name: "search", args: { q: "ruby" } } }] } }],
        usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 7, cachedContentTokenCount: 3 } }
    )
    server = FakeHTTPServer.new(headers: { "content-type" => "text/event-stream" }, body: body, chunked: true)
    events = []
    begin
      request = EZLLM::Request.new(provider: :gemini, model: "gemini-3.5-flash", api_key: "k",
                                   base_url: server.base_url, messages: [{ role: "user", content: "hi" }])
      response = described_class.call(request) { |e| events << e }
    ensure
      server.stop
    end

    expect(events.select { |e| e.type == :thinking_delta }.map(&:text).join).to eq("thinking...")
    expect(events.select { |e| e.type == :text_delta }.map(&:text).join).to eq("Answer")
    done = events.find { |e| e.type == :toolcall_done }
    expect(done.name).to eq("search")
    expect(done.args).to eq("q" => "ruby")
    expect(response.stop_reason).to eq("tool_use")
    # inputTokens excludes cached content (15 - 3)
    expect(response.usage.input_tokens).to eq(12)
    expect(response.usage.cache_read).to eq(3)
  end

  it "targets the streamGenerateContent SSE endpoint with the api key header" do
    body = sse({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] })
    server = FakeHTTPServer.new(headers: { "content-type" => "text/event-stream" }, body: body, chunked: true)
    begin
      request = EZLLM::Request.new(provider: :gemini, model: "gemini-3.5-flash", api_key: "gk",
                                   base_url: server.base_url, messages: [{ role: "user", content: "hi" }])
      described_class.call(request) { |_| }
      sent = server.requests.first
    ensure
      server.stop
    end
    expect(sent[:request_line]).to include("models/gemini-3.5-flash:streamGenerateContent?alt=sse")
    expect(sent[:headers]["x-goog-api-key"]).to eq("gk")
  end
end
