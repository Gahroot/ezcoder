# frozen_string_literal: true

module EZLLM
  module Providers
    # Base for provider adapters. The registry calls `.call(request) { |event| }`;
    # the subclass implements `#run` to build the request, drive the transport
    # (streaming via HTTP.post_stream + SSE.Reader, or buffered via HTTP.post),
    # emit EZLLM::Event objects to the block, and return an EZLLM::Response.
    #
    # Port of the provider entry contract (providers/*.ts + consume-stream.ts).
    class Base
      def self.call(request, &on_event)
        new(request).run(&on_event)
      end

      attr_reader :request

      def initialize(request)
        @request = request
        @on_event = nil
      end

      # Subclasses override. Must return EZLLM::Response.
      def run(&on_event)
        @on_event = on_event
        raise NotImplementedError, "#{self.class} must implement #run"
      end

      protected

      def emit(event)
        @on_event&.call(event)
      end

      def provider_name
        request.provider.to_s
      end

      def streaming?
        request.streaming != false
      end

      def cancellation
        request.cancellation
      end

      def check_aborted!
        return unless cancellation.respond_to?(:aborted?) && cancellation.aborted?

        raise EZLLM::Error.new("Request aborted", source: :ezllm)
      end

      # Parse a tool call's accumulated JSON arguments into a Hash, tolerating
      # the double-encoded-string case some providers emit. Port of parseToolArguments.
      def parse_tool_arguments(args_json)
        return {} if args_json.nil? || args_json.empty?

        parsed = JSON.parse(args_json)
        parsed = JSON.parse(parsed) if parsed.is_a?(String)
        parsed.is_a?(Hash) ? parsed : {}
      rescue JSON::ParserError
        {}
      end
    end
  end
end
