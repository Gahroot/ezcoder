# frozen_string_literal: true

module EZLLM
  # Incremental Server-Sent Events parser + stream reader. Feed raw response
  # body bytes (as they arrive from HTTP.post_stream) into a Reader, and it
  # yields fully-formed {event:, data:} frames split on blank lines. A trailing
  # partial frame is buffered until the next chunk; `flush` emits a final frame
  # that lacks a trailing blank line.
  #
  # Port of packages/ai/src/utils/sse.ts.
  module SSE
    Frame = Data.define(:event, :data)

    # Parse a complete buffer, returning [frames, remaining]. Input is expected
    # to already be CRLF-normalized.
    def self.parse_buffer(buffer)
      frames = []
      cursor = 0

      while (nxt = buffer.index("\n\n", cursor))
        raw = buffer[cursor...nxt]
        cursor = nxt + 2

        event_name = nil
        data_lines = []
        raw.split("\n").each do |line|
          if line.start_with?("event:")
            event_name = line[6..].strip
          elsif line.start_with?("data:")
            data_lines << line[5..].sub(/\A[ \t]+/, "")
          end
        end

        frames << Frame.new(event: event_name, data: data_lines.join("\n")) unless data_lines.empty?
      end

      [frames, buffer[cursor..] || ""]
    end

    # Stateful reader: push raw chunks, yield frames; flush at end of stream.
    class Reader
      def initialize
        @buffer = +""
      end

      # Feed a raw byte chunk; yields each complete SSE frame.
      def push(chunk)
        @buffer << chunk.to_s.gsub("\r\n", "\n")
        frames, remaining = SSE.parse_buffer(@buffer)
        @buffer = remaining
        frames.each { |frame| yield frame }
      end

      # Emit any trailing frame that lacked a closing blank line.
      def flush
        return if @buffer.empty?

        frames, remaining = SSE.parse_buffer("#{@buffer}\n\n")
        @buffer = remaining
        frames.each { |frame| yield frame }
      end
    end
  end
end
