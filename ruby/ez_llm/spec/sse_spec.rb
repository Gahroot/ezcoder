# frozen_string_literal: true

RSpec.describe EZLLM::SSE do
  it "parses event names and joined data lines, buffering partial frames" do
    frames, remaining = described_class.parse_buffer("event: foo\ndata: a\ndata: b\n\ndata: parti")
    expect(frames.map(&:event)).to eq(["foo"])
    expect(frames.first.data).to eq("a\nb")
    expect(remaining).to eq("data: parti")
  end

  it "normalizes CRLF and flushes a trailing frame lacking a blank line" do
    reader = described_class::Reader.new
    seen = []
    reader.push("data: one\r\n\r\ndata: two") { |f| seen << f.data }
    expect(seen).to eq(["one"])
    reader.flush { |f| seen << f.data }
    expect(seen).to eq(%w[one two])
  end

  it "ignores frames with no data lines" do
    frames, = described_class.parse_buffer(": comment only\n\ndata: real\n\n")
    expect(frames.map(&:data)).to eq(["real"])
  end
end
