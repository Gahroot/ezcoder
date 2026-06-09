# frozen_string_literal: true

require "timeout"
require "json"

module EZAgent
  # Executes one tool call with production hardening: argument validation against
  # the tool's schema, fault isolation (any raise becomes a structured error
  # result rather than crashing the loop), a per-tool timeout, cooperative
  # cancellation, optional untrusted-content fencing, and instrumented logging
  # with input redaction. Returns an Outcome the loop turns into a tool_result.
  #
  # Port of toolRunner.ts (+ media-master's redaction/classification).
  class ToolRunner
    DEFAULT_TIMEOUT_SECONDS = 300

    # Result of running one tool. `content` is a String or array of content
    # blocks; `is_error` drives the tool_result.is_error flag; `classification`
    # is a coarse label (:ok/:error/:timeout/:invalid_args/:unknown_tool/:aborted).
    Outcome = Data.define(:tool_call_id, :content, :details, :is_error, :classification, :duration_ms)

    def initialize(registry:, timeout_seconds: DEFAULT_TIMEOUT_SECONDS, logger: nil, fence_untrusted: false)
      @registry = registry
      @timeout_seconds = timeout_seconds
      @logger = logger
      @fence_untrusted = fence_untrusted
    end

    # Run a tool call. `tool_call` is { id:, name:, args: }. `context_data` is the
    # consumer's arbitrary context Hash; `on_update` streams progress; `cancellation`
    # is the run's token. Never raises for tool faults — returns an Outcome.
    def run(tool_call, context_data: nil, cancellation: nil, on_update: nil)
      started = monotonic_ms
      id = tool_call[:id] || tool_call["id"]
      name = tool_call[:name] || tool_call["name"]
      args = tool_call[:args] || tool_call["args"] || {}

      log(:tool_start, name: name, tool_call_id: id, args: redact(args))

      tool = @registry.get(name)
      return finish(id, name, "Unknown tool: #{name}", nil, true, :unknown_tool, started) unless tool

      if cancellation.respond_to?(:aborted?) && cancellation.aborted?
        return finish(id, name, "Tool execution was aborted.", nil, true, :aborted, started)
      end

      validated, errors = tool.schema.validate(args)
      unless errors.empty?
        message = "Invalid arguments for tool `#{name}`:\n#{errors.join("\n")}\n" \
                  "Re-issue the call with each field as the correct type."
        return finish(id, name, message, nil, true, :invalid_args, started)
      end

      execute(tool, id, name, validated, context_data, cancellation, on_update, started)
    end

    private

    def execute(tool, id, name, args, context_data, cancellation, on_update, started)
      ctx = ToolContext.new(tool_call_id: id, cancellation: cancellation,
                            context: context_data, on_update: on_update)
      raw = with_timeout(cancellation) { tool.call(args, ctx) }
      normalized = normalize(raw)
      content = maybe_fence(tool, normalized[:content])
      log(:tool_end, name: name, tool_call_id: id, classification: :ok,
                     duration_ms: monotonic_ms - started)
      finish(id, name, content, normalized[:details], false, :ok, started)
    rescue Timeout::Error
      log(:tool_timeout, name: name, tool_call_id: id, timeout_s: @timeout_seconds)
      finish(id, name, "Tool `#{name}` timed out after #{@timeout_seconds}s.", nil, true, :timeout, started)
    rescue Cancellation::Aborted
      finish(id, name, "Tool execution was aborted.", nil, true, :aborted, started)
    rescue StandardError => e
      log(:tool_error, name: name, tool_call_id: id, error: e.message)
      # Fault isolation: surface the error to the model as a structured result
      # so it can recover, instead of crashing the run.
      finish(id, name, JSON.generate(error: e.message), nil, true, :error, started)
    end

    # Run the block under a timeout, interrupting on cancellation too. The tool
    # runs on the calling thread via Timeout; a watcher thread trips the timeout
    # early if cancellation fires so a cooperative tool can bail promptly.
    def with_timeout(cancellation)
      return yield if @timeout_seconds.nil? || @timeout_seconds <= 0

      Timeout.timeout(@timeout_seconds) do
        if cancellation.respond_to?(:on_abort)
          worker = Thread.current
          cancellation.on_abort { worker.raise(Cancellation::Aborted.new) if worker.alive? }
        end
        yield
      end
    end

    def normalize(raw)
      case raw
      when String then { content: raw, details: nil }
      when Hash
        { content: raw[:content] || raw["content"] || "", details: raw[:details] || raw["details"] }
      else
        { content: raw.to_s, details: nil }
      end
    end

    # Wrap third-party tool output in an untrusted fence when enabled and the
    # tool opted in via `untrusted!`. Only applies to string content.
    def maybe_fence(tool, content)
      return content unless @fence_untrusted && tool.untrusted? && content.is_a?(String)

      Untrusted.fence(content, source: tool.name)
    end

    def finish(id, name, content, details, is_error, classification, started)
      Outcome.new(tool_call_id: id, content: content, details: details, is_error: is_error,
                  classification: classification, duration_ms: monotonic_ms - started)
    end

    # Redact obviously sensitive argument values before logging.
    SENSITIVE_KEY = /pass(word)?|secret|token|api[-_]?key|authorization|credential/i

    def redact(args)
      return args unless args.is_a?(Hash)

      args.each_with_object({}) do |(k, v), out|
        out[k] = if k.to_s.match?(SENSITIVE_KEY)
                   "[redacted]"
                 elsif v.is_a?(String) && v.length > 500
                   "#{v[0, 500]}…[truncated #{v.length - 500} chars]"
                 else
                   v
                 end
      end
    end

    def log(event, **data)
      return unless @logger

      @logger.call(event, data)
    rescue StandardError
      nil
    end

    def monotonic_ms
      (Process.clock_gettime(Process::CLOCK_MONOTONIC) * 1000).to_i
    end
  end
end
