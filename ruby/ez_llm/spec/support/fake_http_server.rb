# frozen_string_literal: true

require "socket"

# A minimal single-threaded HTTP/1.1 server that replays a canned response body
# (e.g. a recorded SSE stream) for any POST. Lets the provider specs exercise
# the real Net::HTTP transport + SSE parsing end-to-end without a live API or an
# extra gem dependency (no WebMock/VCR). Streaming bodies are sent chunked so
# the SSE reader sees realistic frame boundaries.
class FakeHTTPServer
  attr_reader :port, :requests

  def initialize(status: 200, headers: {}, body: "", chunked: false)
    @status = status
    @headers = headers
    @body = body
    @chunked = chunked
    @requests = []
    @server = TCPServer.new("127.0.0.1", 0)
    @port = @server.addr[1]
    @thread = Thread.new { serve_loop }
  end

  def base_url
    "http://127.0.0.1:#{@port}"
  end

  def stop
    @stop = true
    @server.close
    @thread.join(2)
  rescue StandardError
    nil
  end

  private

  def serve_loop
    loop do
      break if @stop

      client = @server.accept
      handle(client)
    rescue IOError, Errno::EBADF
      break
    end
  end

  def handle(client)
    request_line = client.gets
    return unless request_line

    headers = {}
    while (line = client.gets) && line != "\r\n"
      key, value = line.split(":", 2)
      headers[key.downcase.strip] = value.strip if value
    end
    body = +""
    if (len = headers["content-length"]&.to_i) && len.positive?
      body << client.read(len)
    end
    @requests << { request_line: request_line.strip, headers: headers, body: body }

    @chunked ? write_chunked(client) : write_plain(client)
  ensure
    client.close
  end

  def write_plain(client)
    out = +"HTTP/1.1 #{@status} #{status_text}\r\n"
    @headers.each { |k, v| out << "#{k}: #{v}\r\n" }
    out << "content-length: #{@body.bytesize}\r\n"
    out << "connection: close\r\n\r\n"
    out << @body
    client.write(out)
  end

  def write_chunked(client)
    out = +"HTTP/1.1 #{@status} #{status_text}\r\n"
    @headers.each { |k, v| out << "#{k}: #{v}\r\n" }
    out << "transfer-encoding: chunked\r\n"
    out << "connection: close\r\n\r\n"
    client.write(out)
    # Split the body into a few chunks to exercise incremental SSE parsing.
    @body.scan(/.{1,64}/m).each do |piece|
      client.write("#{piece.bytesize.to_s(16)}\r\n#{piece}\r\n")
    end
    client.write("0\r\n\r\n")
  end

  def status_text
    { 200 => "OK", 400 => "Bad Request", 402 => "Payment Required",
      429 => "Too Many Requests", 500 => "Internal Server Error" }.fetch(@status, "OK")
  end
end
