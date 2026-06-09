# frozen_string_literal: true

module EZAgent
  # The multi-turn agent loop. Call the LLM, yield its deltas, execute any tool
  # calls in-process via ToolRunner, append results, and loop until the model
  # stops calling tools (or a budget is hit). Blocking-with-yield: `run` yields
  # each Event to the given block and returns the final Result. The consumer owns
  # concurrency (run it inline, in a Thread, in a Fiber, or in a job).
  #
  # Ported from agent-loop.ts with its production recovery: turn/continuation
  # budgets, overload/rate-limit backoff, empty-response retry, context-overflow
  # compaction, tool-pairing + thinking-block repair, non-streaming fallback, a
  # sliding message window, steering/follow-up hooks, and the OPTIONAL approval
  # gate + untrusted fencing.
  class Loop
    DEFAULT_MAX_TURNS = 300
    DEFAULT_MAX_CONTINUATIONS = 5
    MAX_OVERLOAD_RETRIES = 10
    MAX_EMPTY_RESPONSE_RETRIES = 2
    MAX_STALL_RETRIES = 5
    MAX_OVERFLOW_COMPACTIONS = 2
    STALL_RETRIES_BEFORE_NON_STREAMING = 2
    OVERLOAD_BASE_DELAY_MS = 2_000
    OVERLOAD_MAX_DELAY_MS = 30_000
    STALL_DELAY_MS = 1_000

    # @param provider [Symbol] e.g. :anthropic
    # @param model [String]
    # @param tools [Array<EZAgent::Tool, Class>] tool instances or classes
    # @param system [String, nil] optional system prompt
    # @param approval [EZAgent::ApprovalGate, nil] optional HITL gate (off by default)
    # @param transform_context [#call, nil] called before each LLM call to
    #   compact/transform history; receives (messages, force:) and returns messages
    # @param fence_untrusted [Boolean] fence output of tools marked `untrusted!`
    def initialize(provider:, model:, tools: [], system: nil, approval: nil,
                   max_turns: DEFAULT_MAX_TURNS, max_continuations: DEFAULT_MAX_CONTINUATIONS,
                   max_tokens: nil, temperature: nil, thinking: nil,
                   max_tool_result_chars: 100_000, tool_timeout_seconds: ToolRunner::DEFAULT_TIMEOUT_SECONDS,
                   supports_images: nil, supports_video: nil, web_search: nil,
                   compaction: nil, clear_tool_uses: nil, cache_retention: nil, prompt_cache_key: nil,
                   transform_context: nil, fence_untrusted: false, logger: nil, diagnostics: nil,
                   overload_base_delay_ms: OVERLOAD_BASE_DELAY_MS,
                   overload_max_delay_ms: OVERLOAD_MAX_DELAY_MS, stall_delay_ms: STALL_DELAY_MS)
      @provider = provider.to_sym
      @model = model
      @registry = tools.is_a?(ToolRegistry) ? tools : ToolRegistry.new(tools)
      @system = system
      @approval = approval
      @max_turns = max_turns
      @max_continuations = max_continuations
      @max_tokens = max_tokens
      @temperature = temperature
      @thinking = thinking
      @max_tool_result_chars = max_tool_result_chars
      @supports_images = supports_images
      @supports_video = supports_video
      @web_search = web_search
      @compaction = compaction
      @clear_tool_uses = clear_tool_uses
      @cache_retention = cache_retention
      @prompt_cache_key = prompt_cache_key
      @transform_context = transform_context
      @fence_untrusted = fence_untrusted
      @logger = logger
      @diagnostics = diagnostics
      @overload_base_delay_ms = overload_base_delay_ms
      @overload_max_delay_ms = overload_max_delay_ms
      @stall_delay_ms = stall_delay_ms
      @tool_runner = ToolRunner.new(registry: @registry, timeout_seconds: tool_timeout_seconds,
                                    logger: logger, fence_untrusted: fence_untrusted)
    end

    # Run the loop. `messages` is the conversation (without system — the loop
    # prepends `@system` if set). `credentials` resolves per-call auth as either a
    # Hash { api_key:, base_url:, account_id:, project_id: } or a callable
    # `->(provider) { {...} }`. `context` is arbitrary data threaded to tools.
    # `cancellation` is an optional token. Yields Events; returns a Result.
    def run(messages:, credentials: {}, context: nil, cancellation: nil, &on_event)
      state = RunState.new(
        messages: build_initial_messages(messages),
        seq: Sequence.new,
        creds: resolve_credentials(credentials),
        context: context,
        cancellation: cancellation,
        on_event: on_event
      )
      drive(state)
    end

    # Enumerator form: `loop.run_enum(...).each { |event| ... }`. Buffers events
    # and exposes the final Result via the enumerator's return value.
    def run_enum(messages:, **opts)
      Enumerator.new do |yielder|
        run(messages: messages, **opts) { |event| yielder << event }
      end
    end

    private

    # Mutable per-run state, kept in one object so helper methods stay readable.
    RunState = Struct.new(
      :messages, :seq, :creds, :context, :cancellation, :on_event,
      :turn, :total_usage, :consecutive_pauses, :overload_retries, :empty_retries,
      :stall_retries, :overflow_compactions, :non_streaming, :tool_pairing_repaired,
      :thinking_stripped, :tool_result_truncated, :always_allow,
      keyword_init: true
    ) do
      def initialize(**args)
        super
        self.turn ||= 0
        self.total_usage ||= EZLLM::Usage.new
        self.consecutive_pauses ||= 0
        self.overload_retries ||= 0
        self.empty_retries ||= 0
        self.stall_retries ||= 0
        self.overflow_compactions ||= 0
        self.non_streaming ||= false
        self.tool_pairing_repaired ||= false
        self.thinking_stripped ||= false
        self.tool_result_truncated ||= false
        self.always_allow ||= {}
      end
    end

    def build_initial_messages(messages)
      msgs = messages.map { |m| deep_dup(m) }
      msgs.unshift({ role: "system", content: @system }) if @system && msgs.none? { |m| (m[:role] || m["role"]) == "system" }
      msgs
    end

    # ── main loop ──────────────────────────────────────────
    def drive(state)
      while state.turn < @max_turns
        state.cancellation&.check! if state.cancellation.respond_to?(:check!)
        return finished_result(state) if aborted?(state)

        state.turn += 1
        apply_transform_context(state)
        MessageRepair.repair_tool_pairing!(state.messages)

        response = call_llm_with_recovery(state)
        next if response == :retry
        return response if response.is_a?(Result) # hard stop surfaced as final result

        state.overload_retries = 0
        state.stall_retries = 0

        next if handle_empty_response(state, response)

        state.non_streaming = false
        accumulate_usage(state, response.usage)
        state.messages << response.message
        emit(state, Event::TurnEnd.new(seq: state.seq.next, turn: state.turn,
                                       stop_reason: response.stop_reason, usage: response.usage))

        if response.stop_reason == "pause_turn"
          state.consecutive_pauses += 1
          break if state.consecutive_pauses >= @max_continuations

          next
        end
        state.consecutive_pauses = 0

        tool_calls = extract_tool_calls(response.message)
        if response.stop_reason != "tool_use" && tool_calls.empty?
          next if inject_steering(state)
          next if inject_follow_up(state)

          return done(state, response.message)
        end

        break if execute_tools(state, tool_calls) == :abort

        inject_steering(state)
      end

      finished_result(state)
    end

    # ── LLM call + recovery ────────────────────────────────
    def call_llm_with_recovery(state)
      stream_chars = StreamCharCounter.new
      response = EZLLM.stream(**request_options(state)) do |event|
        forward_stream_event(state, event, stream_chars)
      end
      response
    rescue StandardError => e
      recover_from_error(state, e)
    end

    def request_options(state)
      opts = {
        provider: @provider, model: @model, messages: state.messages,
        api_key: state.creds[:api_key], base_url: state.creds[:base_url],
        account_id: state.creds[:account_id], project_id: state.creds[:project_id],
        cancellation: state.cancellation
      }
      opts[:tools] = @registry.to_llm_tools unless @registry.empty?
      opts[:max_tokens] = @max_tokens if @max_tokens
      opts[:temperature] = @temperature unless @temperature.nil?
      opts[:thinking] = @thinking if @thinking
      opts[:supports_images] = @supports_images unless @supports_images.nil?
      opts[:supports_video] = @supports_video unless @supports_video.nil?
      opts[:web_search] = @web_search unless @web_search.nil?
      opts[:compaction] = @compaction unless @compaction.nil?
      opts[:clear_tool_uses] = @clear_tool_uses unless @clear_tool_uses.nil?
      opts[:cache_retention] = @cache_retention if @cache_retention
      opts[:prompt_cache_key] = @prompt_cache_key if @prompt_cache_key
      opts[:streaming] = false if state.non_streaming
      opts
    end

    def forward_stream_event(state, event, stream_chars)
      case event.type
      when :text_delta
        emit(state, Event::TextDelta.new(seq: state.seq.next, text: event.text))
      when :thinking_delta
        emit(state, Event::ThinkingDelta.new(seq: state.seq.next, text: event.text))
      when :toolcall_delta
        chars = event.args_json.to_s.length
        stream_chars.add(chars)
        emit(state, Event::ToolCallDelta.new(seq: state.seq.next, chars: chars))
      when :server_toolcall
        emit(state, Event::ServerToolCall.new(seq: state.seq.next, id: event.id, name: event.name, input: event.input))
      when :server_toolresult
        emit(state, Event::ServerToolResult.new(seq: state.seq.next, tool_use_id: event.tool_use_id,
                                                result_type: event.result_type, data: event.data))
      end
    end

    # Returns :retry to re-enter the loop, a Result to hard-stop, or re-raises.
    def recover_from_error(state, err)
      diag(:stream_error, error: err.message[0, 200])
      raise err if aborted?(state)

      return handle_usage_limit(state, err) if EZLLM::Errors.usage_limit?(err)
      return handle_overflow(state, err) if EZLLM::Errors.context_overflow?(err)

      overload = EZLLM::Errors.classify_overload(err)
      return retry_overload(state, err, overload) if overload && state.overload_retries < MAX_OVERLOAD_RETRIES

      return retry_stall(state, err) if transport_failure?(state, err) && state.stall_retries < MAX_STALL_RETRIES
      return stall_exhausted(state) if transport_failure?(state, err)

      if EZLLM::Errors.tool_pairing?(err) && !state.tool_pairing_repaired
        state.tool_pairing_repaired = true
        MessageRepair.repair_tool_pairing!(state.messages)
        state.turn -= 1
        return :retry
      end
      if EZLLM::Errors.thinking_block?(err) && !state.thinking_stripped
        state.thinking_stripped = true
        MessageRepair.strip_thinking_blocks!(state.messages)
        state.turn -= 1
        return :retry
      end
      return finished_result(state) if EZLLM::Errors.abort?(err)

      raise err
    end

    def handle_usage_limit(_state, err)
      raise err
    end

    def handle_overflow(state, err)
      details = EZLLM::Errors.context_overflow_details(err)
      max_chars = [@max_tool_result_chars || 100_000, 100_000].min
      unless state.tool_result_truncated
        state.tool_result_truncated = true
        if MessageRepair.truncate_oversized_tool_results!(state.messages, max_chars)
          emit_retry(state, :overflow_compact, state.overflow_compactions + 1, MAX_OVERFLOW_COMPACTIONS, 0, details, silent: true)
          state.turn -= 1
          return :retry
        end
      end

      if @transform_context && state.overflow_compactions < MAX_OVERFLOW_COMPACTIONS
        state.overflow_compactions += 1
        compacted = call_transform(state.messages, force: true)
        if compacted && compacted.length < state.messages.length
          before = state.messages.length
          state.messages.replace(compacted)
          emit(state, Event::Compacted.new(seq: state.seq.next, before: before, after: compacted.length))
          emit_retry(state, :overflow_compact, state.overflow_compactions, MAX_OVERFLOW_COMPACTIONS, 0, details)
          state.turn -= 1
          return :retry
        end
      end

      emit(state, Event::AgentError.new(seq: state.seq.next, error: err))
      raise err
    end

    def retry_overload(state, err, kind)
      state.overload_retries += 1
      server_delay = EZLLM::Errors.server_reset_delay_ms(err)
      delay = if server_delay
                [server_delay, @overload_max_delay_ms].min
              else
                [@overload_base_delay_ms * (2**(state.overload_retries - 1)), @overload_max_delay_ms].min
              end
      emit_retry(state, kind, state.overload_retries, MAX_OVERLOAD_RETRIES, delay)
      sleep_ms(delay, state)
      state.turn -= 1
      :retry
    end

    def retry_stall(state, _err)
      state.stall_retries += 1
      if !state.non_streaming && state.stall_retries >= STALL_RETRIES_BEFORE_NON_STREAMING
        state.non_streaming = true
        diag(:non_streaming_fallback_enabled, stall_retries: state.stall_retries)
      end
      delay = [@stall_delay_ms * (2**(state.stall_retries - 1)), 8_000].min
      emit_retry(state, :stream_stall, state.stall_retries, MAX_STALL_RETRIES, delay, silent: state.stall_retries <= 2)
      sleep_ms(delay, state)
      state.turn -= 1
      :retry
    end

    def stall_exhausted(state)
      emit(state, Event::AgentError.new(seq: state.seq.next, error: StandardError.new(
        "The provider's stream stalled #{MAX_STALL_RETRIES} times. Your conversation is preserved."
      )))
      finished_result(state)
    end

    def transport_failure?(_state, err)
      EZLLM::Errors.transport_failure?(err) || EZLLM::Errors.malformed_stream?(err)
    end

    # ── empty response ─────────────────────────────────────
    def handle_empty_response(state, response)
      return false if actionable?(response.message)

      if state.empty_retries < MAX_EMPTY_RESPONSE_RETRIES
        state.empty_retries += 1
        emit_retry(state, :empty_response, state.empty_retries, MAX_EMPTY_RESPONSE_RETRIES, 0)
        state.turn -= 1
        return true
      end
      state.empty_retries = 0
      false
    end

    def actionable?(message)
      content = message[:content] || message["content"]
      return false if content == ""
      return false unless content.is_a?(Array)

      content.any? { |p| %w[text tool_call server_tool_call].include?(p[:type] || p["type"]) }
    end

    # ── tool execution ─────────────────────────────────────
    def execute_tools(state, tool_calls)
      builtin_results = []
      client_calls = []
      tool_calls.each do |tc|
        if tc[:name].to_s.start_with?("$")
          builtin_results << EZLLM::Types.tool_result(tool_call_id: tc[:id], content: JSON.generate(tc[:args]))
        else
          client_calls << tc
        end
      end

      # Tools run in source order. Core is blocking-with-yield and the consumer
      # owns concurrency, so `sequential!` is metadata a consumer may read via
      # Tool#execution_mode — the loop itself never races tool calls.
      results = builtin_results
      aborted = false

      client_calls.each do |tc|
        if aborted?(state)
          aborted = true
          break
        end
        decision = gate_decision(state, tc)
        if decision == :deny
          results << EZLLM::Types.tool_result(tool_call_id: tc[:id],
                                              content: "Tool call denied by the user.", is_error: true)
          next
        end

        results << run_single_tool(state, tc)
      end

      append_tool_results(state, client_calls, results, aborted)
      aborted ? :abort : :ok
    end

    def run_single_tool(state, tool_call)
      emit(state, Event::ToolCallStart.new(seq: state.seq.next, tool_call_id: tool_call[:id],
                                           name: tool_call[:name], args: tool_call[:args]))
      outcome = @tool_runner.run(
        tool_call,
        context_data: state.context,
        cancellation: state.cancellation,
        on_update: ->(payload) { emit(state, Event::ToolCallUpdate.new(seq: state.seq.next, tool_call_id: tool_call[:id], update: payload)) }
      )
      content = Truncation.cap(outcome.content, @max_tool_result_chars)
      emit(state, Event::ToolCallEnd.new(seq: state.seq.next, tool_call_id: tool_call[:id],
                                         result: preview(content), details: outcome.details,
                                         is_error: outcome.is_error, duration_ms: outcome.duration_ms))
      EZLLM::Types.tool_result(tool_call_id: tool_call[:id], content: content, is_error: outcome.is_error || nil)
    end

    def append_tool_results(state, client_calls, results, aborted)
      present = results.map { |r| r[:tool_call_id] }
      client_calls.each do |tc|
        next if present.include?(tc[:id])

        results << EZLLM::Types.tool_result(tool_call_id: tc[:id], content: "Tool execution was aborted.", is_error: true)
      end
      state.messages << { role: "tool", content: results } unless results.empty?
      aborted
    end

    # ── approval gate ──────────────────────────────────────
    # Returns :allow or :deny. The gate (when present) owns the policy and the
    # per-run always-allow list; the loop only surfaces the confirm event.
    def gate_decision(state, tool_call)
      return :allow unless @approval

      tool = @registry.get(tool_call[:name])
      return :allow unless @approval.requires_confirmation?(tool_call[:name], tool)

      # Only surface a confirm event when the gate will actually prompt the user
      # — not when it auto-resolves via the always-allow list or cron mode.
      if @approval.prompt_needed?(tool_call[:name])
        emit(state, Event::ToolConfirmRequest.new(seq: state.seq.next, tool_call_id: tool_call[:id],
                                                  name: tool_call[:name], args: tool_call[:args]))
      end
      @approval.request(name: tool_call[:name], args: tool_call[:args], tool_call_id: tool_call[:id])
    end

    # ── steering / follow-up ───────────────────────────────
    def inject_steering(state)
      inject_messages(state, @steering_provider, :steering_message)
    end

    def inject_follow_up(state)
      inject_messages(state, @follow_up_provider, :follow_up_message)
    end

    def inject_messages(state, provider, event_kind)
      return false unless provider

      msgs = provider.call
      return false if msgs.nil? || msgs.empty?

      msgs.each do |msg|
        klass = event_kind == :steering_message ? Event::SteeringMessage : Event::FollowUpMessage
        emit(state, klass.new(seq: state.seq.next, content: msg[:content] || msg["content"]))
        state.messages << msg
      end
      true
    end

    public

    # Register a steering-message provider: a callable returning an array of user
    # messages (or nil) to inject after tool execution. Consumed on read.
    def on_steering(&block)
      @steering_provider = block
      self
    end

    # Register a follow-up provider: lower priority than steering — only polled
    # when the agent would otherwise stop.
    def on_follow_up(&block)
      @follow_up_provider = block
      self
    end

    private

    # ── helpers ────────────────────────────────────────────
    def apply_transform_context(state)
      return unless @transform_context

      transformed = call_transform(state.messages, force: false)
      return unless transformed && !transformed.equal?(state.messages)

      before = state.messages.length
      state.messages.replace(transformed)
      emit(state, Event::Compacted.new(seq: state.seq.next, before: before, after: transformed.length)) if transformed.length != before
    end

    def call_transform(messages, force:)
      return nil unless @transform_context

      if @transform_context.respond_to?(:arity) && @transform_context.arity == 1
        @transform_context.call(messages)
      else
        @transform_context.call(messages, force)
      end
    rescue StandardError => e
      diag(:transform_failed, error: e.message)
      nil
    end

    def extract_tool_calls(message)
      content = message[:content] || message["content"]
      return [] unless content.is_a?(Array)

      content.select { |p| (p[:type] || p["type"]) == "tool_call" }
             .map { |p| { id: p[:id] || p["id"], name: p[:name] || p["name"], args: p[:args] || p["args"] || {} } }
    end

    def accumulate_usage(state, usage)
      state.total_usage = state.total_usage + usage
    end

    def done(state, message)
      total = state.total_usage
      emit(state, Event::AgentDone.new(seq: state.seq.next, total_turns: state.turn, total_usage: total))
      Result.new(message: message, total_turns: state.turn, total_usage: total)
    end

    def finished_result(state)
      last = state.messages.reverse.find { |m| (m[:role] || m["role"]) == "assistant" }
      emit(state, Event::AgentDone.new(seq: state.seq.next, total_turns: state.turn, total_usage: state.total_usage))
      Result.new(message: last || { role: "assistant", content: [] },
                 total_turns: state.turn, total_usage: state.total_usage)
    end

    def emit(state, event)
      state.on_event&.call(event)
    end

    def emit_retry(state, reason, attempt, max_attempts, delay_ms, details = {}, silent: false)
      emit(state, Event::Retry.new(seq: state.seq.next, reason: reason, attempt: attempt,
                                   max_attempts: max_attempts, delay_ms: delay_ms,
                                   observed_tokens: details[:observed_tokens],
                                   observed_limit: details[:observed_limit], silent: silent))
    end

    def aborted?(state)
      state.cancellation.respond_to?(:aborted?) && state.cancellation.aborted?
    end

    def sleep_ms(ms, state)
      deadline = monotonic_ms + ms
      while monotonic_ms < deadline
        return if aborted?(state)

        sleep([(deadline - monotonic_ms) / 1000.0, 0.05].min)
      end
    end

    def preview(content)
      return content if content.is_a?(String)

      Array(content).map { |b| (b[:type] || b["type"]) == "text" ? (b[:text] || b["text"]) : "[#{b[:type] || b["type"]}]" }.join("\n")
    end

    def resolve_credentials(credentials)
      creds = credentials.respond_to?(:call) ? credentials.call(@provider) : credentials
      creds = creds.transform_keys(&:to_sym) if creds.is_a?(Hash)
      creds || {}
    end

    def deep_dup(value)
      case value
      when Hash then value.to_h { |k, v| [k, deep_dup(v)] }
      when Array then value.map { |v| deep_dup(v) }
      else value
      end
    end

    def diag(phase, data = {})
      @diagnostics&.call(phase, data)
    rescue StandardError
      nil
    end

    def monotonic_ms
      (Process.clock_gettime(Process::CLOCK_MONOTONIC) * 1000).to_i
    end

    # Tracks accumulated tool-call argument chars across a stream (UI hint).
    class StreamCharCounter
      def initialize
        @total = 0
      end

      def add(chars)
        @total += chars
      end

      attr_reader :total
    end
  end
end
