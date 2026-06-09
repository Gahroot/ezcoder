# frozen_string_literal: true

require "net/http"
require "uri"
require "json"

module EZLLM
  # Thin streaming HTTP client over Net::HTTP. Keeps `ez_llm` dependency-light:
  # no Faraday, no vendor SDKs — just the standard library. Supports both a
  # streaming POST (response body chunks yielded as they arrive, for SSE) and a
  # plain POST (full body buffered, for the non-streaming fallback path).
  module HTTP
    # Non-2xx HTTP response. Providers translate this into a ProviderError with
    # provider-specific classification.
    class HTTPError < StandardError
      attr_reader :status, :body, :headers

      def initialize(status, body, headers = {})
        @status = status
        @body = body
        @headers = headers
        super("HTTP #{status}")
      end
    end

    Result = Data.define(:status, :headers, :body)

    DEFAULT_OPEN_TIMEOUT = 30
    DEFAULT_READ_TIMEOUT = 600

    module_function

    # Stream a POST. 2xx body bytes are yielded to the block as they arrive.
    # Raises HTTPError on a non-2xx status (after buffering the error body) and
    # Cancellation::Aborted when the cancellation token fires between chunks.
    def post_stream(url:, headers:, body:, cancellation: nil,
                    open_timeout: DEFAULT_OPEN_TIMEOUT, read_timeout: DEFAULT_READ_TIMEOUT, &on_chunk)
      raise ArgumentError, "post_stream requires a block" unless on_chunk

      with_connection(url, open_timeout: open_timeout, read_timeout: read_timeout) do |http, uri|
        request = build_post(uri, headers, body)
        http.request(request) do |response|
          status = response.code.to_i
          unless (200..299).cover?(status)
            raise HTTPError.new(status, response.read_body, header_hash(response))
          end

          response.read_body do |chunk|
            check_cancelled!(cancellation)
            on_chunk.call(chunk)
          end
        end
      end
      nil
    end

    # Plain POST — buffers and returns the full response. Raises HTTPError on
    # non-2xx. Used by the non-streaming fallback transport.
    def post(url:, headers:, body:, cancellation: nil,
             open_timeout: DEFAULT_OPEN_TIMEOUT, read_timeout: DEFAULT_READ_TIMEOUT)
      check_cancelled!(cancellation)
      with_connection(url, open_timeout: open_timeout, read_timeout: read_timeout) do |http, uri|
        response = http.request(build_post(uri, headers, body))
        status = response.code.to_i
        unless (200..299).cover?(status)
          raise HTTPError.new(status, response.body, header_hash(response))
        end

        Result.new(status: status, headers: header_hash(response), body: response.body)
      end
    end

    def with_connection(url, open_timeout:, read_timeout:)
      uri = url.is_a?(URI) ? url : URI.parse(url)
      http = Net::HTTP.new(uri.host, uri.port)
      http.use_ssl = uri.scheme == "https"
      http.open_timeout = open_timeout
      http.read_timeout = read_timeout
      http.start unless http.started?
      begin
        yield(http, uri)
      ensure
        http.finish if http.started?
      end
    end

    def build_post(uri, headers, body)
      request = Net::HTTP::Post.new(uri.request_uri)
      headers.each { |key, value| request[key] = value }
      request["content-type"] ||= "application/json"
      request.body = body.is_a?(String) ? body : JSON.generate(body)
      request
    end

    def header_hash(response)
      out = {}
      response.each_header { |key, value| out[key] = value }
      out
    end

    def check_cancelled!(cancellation)
      return unless cancellation.respond_to?(:aborted?) && cancellation.aborted?

      raise EZLLM::Error.new("Request aborted", source: :ezllm)
    end
  end
end
