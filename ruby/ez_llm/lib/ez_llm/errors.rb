# frozen_string_literal: true

module EZLLM
  # Error classifiers and human-facing formatting. Single source of truth for
  # the billing/overflow/overload/abort/stall/tool-pairing detection shared by
  # the provider boundary and the agent loop, so the heuristics can't drift.
  #
  # Ported from packages/ai/src/errors.ts and the agent-loop classifiers.
  module Errors
    module_function

    # ── Provider display + status ────────────────────────────
    PROVIDER_DISPLAY = {
      "openai" => "OpenAI",
      "anthropic" => "Anthropic",
      "gemini" => "Gemini",
      "glm" => "Z.AI (GLM)",
      "moonshot" => "Moonshot",
      "deepseek" => "DeepSeek",
      "openrouter" => "OpenRouter",
      "xiaomi" => "Xiaomi (MiMo)",
      "minimax" => "MiniMax"
    }.freeze

    PROVIDER_STATUS_URL = {
      "openai" => "status.openai.com",
      "anthropic" => "status.anthropic.com"
    }.freeze

    def provider_display_name(provider)
      PROVIDER_DISPLAY[provider.to_s] || provider.to_s
    end

    # ── Classifiers (shared with the agent loop) ─────────────

    # Subscription/plan usage-window exhaustion (not a transient throttle). These
    # don't clear with a quick retry — surface as a hard stop, not silent retry.
    def usage_limit?(err)
      return false unless err.is_a?(Exception)

      err.message.to_s.match?(/usage limit reached/i)
    end

    # Substrings marking a hard, non-retriable billing/quota stop on ANY provider.
    def hard_billing_message?(message)
      lower = message.to_s.downcase
      [
        "insufficient balance", "insufficient credits", "more credits",
        "insufficient_quota", "exceeded your current quota", "quota exceeded",
        "no resource package", "recharge", "balance is too low", "out of credits",
        "arrears", "arrearage", "token quota", "exceeded_current_quota_error",
        "check your account balance", "does not yet include access",
        "subscription plan", "billing"
      ].any? { |needle| lower.include?(needle) }
    end

    # Billing/quota errors — must NOT be retried. HTTP 402 is always hard.
    def billing?(err)
      return false unless err.is_a?(Exception)
      return true if status_code(err) == 402

      hard_billing_message?(err.message)
    end

    # Context-window overflow. 402 and billing are excluded (credit, not size).
    def context_overflow?(err)
      return false unless err.is_a?(Exception)
      return false if status_code(err) == 402
      return false if billing?(err)

      msg = err.message.to_s.downcase
      [
        "prompt is too long", "prompt too long", "input is too long",
        "context_length_exceeded", "context_window_exceeded",
        "maximum context length", "exceeds model context window",
        "exceeds the context window", "content_too_large", "request_too_large",
        "reduce the length", "please shorten"
      ].any? { |n| msg.include?(n) } || (msg.include?("token") && msg.include?("exceed"))
    end

    # Extract provider-reported {observed_tokens:, observed_limit:} from an
    # overflow message when present.
    def context_overflow_details(err)
      return {} unless err.is_a?(Exception)

      text = err.message.to_s
      patterns = [
        [/([\d,_.\s]+)\s*tokens?\s*>\s*([\d,_.\s]+)\s*(?:maximum|max|limit)?/i, 1, 2],
        [%r{maximum context length is\s*([\d,_.\s]+)\s*tokens?[\s\S]*?resulted in\s*([\d,_.\s]+)\s*tokens?}i, 2, 1],
        [%r{([\d,_.\s]+)\s*(?:input\s*)?tokens?[\s\S]{0,80}?exceeds?[\s\S]{0,80}?([\d,_.\s]+)\s*(?:token\s*)?(?:limit|maximum|max)}i, 1, 2]
      ]
      patterns.each do |regex, tokens_group, limit_group|
        match = text.match(regex)
        next unless match

        observed_tokens = parse_overflow_number(match[tokens_group].to_s)
        observed_limit = parse_overflow_number(match[limit_group].to_s)
        out = {}
        out[:observed_tokens] = observed_tokens if observed_tokens.positive?
        out[:observed_limit] = observed_limit if observed_limit.positive?
        return out
      end
      {}
    end

    def parse_overflow_number(value)
      value.gsub(/[,_\s]/, "").to_i
    end

    # Tool pairing 400 — orphaned tool_use / tool_result. Recoverable via repair.
    def tool_pairing?(err)
      return false unless err.is_a?(Exception)

      msg = err.message.to_s.downcase
      (msg.include?("tool_use") && msg.include?("tool_result")) ||
        msg.include?("unexpected `tool_use_id`") ||
        msg.include?("tool_use ids found without") ||
        (msg.include?("tool call id") && msg.include?("is not found"))
    end

    # Anthropic thinking-block integrity 400. Recoverable once by stripping
    # thinking blocks from history and re-sending.
    def thinking_block?(err)
      return false unless err.is_a?(Exception)

      msg = err.message.to_s.downcase
      return false unless msg.include?("thinking")

      msg.include?("cannot be modified") ||
        msg.include?("must remain as they were") ||
        (msg.include?("signature") && msg.include?("invalid")) ||
        (msg.include?("expected") && msg.include?("but found"))
    end

    # Distinguish rate-limit (429), overload (529), and transient 5xx. Returns
    # one of :rate_limit, :overloaded, :provider_error, or nil (don't retry).
    def classify_overload(err)
      return nil unless err.is_a?(Exception)
      return nil if billing?(err)
      return nil if usage_limit?(err)

      status = status_code(err)
      return nil if status == 402

      msg = err.message.to_s.downcase
      if status == 429 || msg.include?("rate_limit") || msg.include?("rate limit") ||
         msg.include?("too many requests") || msg.include?("429")
        return :rate_limit
      end
      return :overloaded if status == 529 || msg.include?("overloaded") || msg.include?("529")

      if [500, 502, 503, 504].include?(status) || msg.include?("api_error") ||
         msg.include?("server_error") || msg.include?("internal server error") ||
         msg.include?("bad gateway") || msg.include?("service unavailable") ||
         msg.include?("gateway timeout")
        return :provider_error
      end

      nil
    end

    def overloaded?(err)
      !classify_overload(err).nil?
    end

    # Abort errors — user-initiated cancellation. Caught and handled gracefully.
    def abort?(err)
      return false unless err.is_a?(Exception)

      msg = err.message.to_s.downcase
      msg.include?("aborted") || msg.include?("abort")
    end

    # Socket-level transport failures — peer closed the connection mid-stream.
    # Same recovery as a stall: replay, optionally non-streaming.
    def transport_failure?(err)
      seen = []
      cur = err
      while cur.is_a?(Exception) && !seen.include?(cur)
        seen << cur
        msg = cur.message.to_s
        return true if cur.is_a?(Errno::ECONNRESET) || cur.is_a?(Errno::ECONNREFUSED) ||
                       cur.is_a?(Errno::ETIMEDOUT) || cur.is_a?(Errno::EPIPE) ||
                       cur.is_a?(Errno::EHOSTUNREACH) || cur.is_a?(::SocketError) ||
                       (defined?(::Net::OpenTimeout) && cur.is_a?(::Net::OpenTimeout)) ||
                       (defined?(::Net::ReadTimeout) && cur.is_a?(::Net::ReadTimeout))
        return true if [
          /\Aterminated\z/i, /\bother side closed\b/i, /\bsocket hang up\b/i,
          /\bfetch failed\b/i, /\bbody timeout error\b/i,
          /\bsse stream disconnected\b/i, /\bfailed to reconnect sse stream\b/i,
          /\bend of file reached\b/i, /\bconnection reset\b/i
        ].any? { |re| msg.match?(re) }

        cur = cur.cause
      end
      false
    end

    # Malformed stream — JSON decode failure mid-stream (truncated/corrupted SSE).
    def malformed_stream?(err)
      return false unless err.is_a?(Exception)
      return true if err.is_a?(JSON::ParserError)

      cause = err.cause
      return true if cause.is_a?(JSON::ParserError)

      err.message.to_s.match?(/in JSON at position \d+/i) ||
        err.message.to_s.match?(/unexpected token|unexpected end/i)
    end

    # Provider-stated reset → delay in ms from now, or nil when absent/elapsed.
    def server_reset_delay_ms(err)
      return nil unless err.respond_to?(:resets_at)

      resets_at = err.resets_at
      return nil unless resets_at.is_a?(Numeric)

      delay_ms = (resets_at * 1000) - now_ms
      delay_ms.positive? ? delay_ms : nil
    end

    def status_code(err)
      err.respond_to?(:status_code) ? err.status_code : nil
    end

    def now_ms
      (Process.clock_gettime(Process::CLOCK_REALTIME) * 1000).to_i
    end

    # ── Human-facing formatting ──────────────────────────────

    FormattedError = Data.define(:headline, :source, :message, :guidance,
                                 :provider, :status_code, :request_id, :resets_at)

    def format_error(err)
      if err.is_a?(ProviderError)
        return format_provider_error(err)
      end
      if err.is_a?(Error)
        return finalise_by_source(err.source, err.message, err.request_id, err.hint)
      end
      if err.is_a?(Exception)
        return finalise_by_source(infer_source(err), err.message, nil, nil)
      end

      finalise_by_source(:ezllm, err.to_s, nil, nil)
    end

    def format_error_for_display(err)
      f = format_error(err)
      lines = [f.headline]
      lines << "  #{f.message}" if f.message && !f.message.empty? && f.message != f.headline
      lines << "  → #{f.guidance}"
      lines.join("\n")
    end

    def format_provider_error(err)
      name = provider_display_name(err.provider)
      clean = clean_provider_message(err.message)
      if usage_limit?(err)
        reset_clause = err.resets_at ? " It resets at #{format_reset_time(err.resets_at)}." : ""
        return FormattedError.new(
          headline: "#{name} usage limit reached.", source: :provider,
          message: "Your #{name} usage is finished.#{reset_clause}",
          guidance: "Try again once it's back. Your conversation is preserved.",
          provider: err.provider, status_code: err.status_code,
          request_id: err.request_id, resets_at: err.resets_at
        )
      end
      FormattedError.new(
        headline: "#{name} returned an error.", source: :provider, message: clean,
        guidance: err.hint || provider_guidance(err.provider, clean, err.status_code),
        provider: err.provider, status_code: err.status_code,
        request_id: err.request_id, resets_at: nil
      )
    end

    def finalise_by_source(source, message, request_id, hint)
      case source
      when :network
        FormattedError.new(headline: "Network error — couldn't reach the provider.",
                           source: source, message: message,
                           guidance: hint || "Check your internet connection. Retry shortly.",
                           provider: nil, status_code: nil, request_id: request_id, resets_at: nil)
      when :auth
        FormattedError.new(headline: "Authentication issue.", source: source, message: message,
                           guidance: hint || "Refresh your credentials.",
                           provider: nil, status_code: nil, request_id: request_id, resets_at: nil)
      when :provider
        FormattedError.new(headline: "Provider returned an error.", source: source, message: message,
                           guidance: hint || provider_guidance(nil, message, nil),
                           provider: nil, status_code: nil, request_id: request_id, resets_at: nil)
      when :capability
        FormattedError.new(headline: message, source: source, message: "",
                           guidance: hint || "Only video-capable models can analyze video. Switch models.",
                           provider: nil, status_code: nil, request_id: request_id, resets_at: nil)
      else
        FormattedError.new(headline: "EZLLM hit an unexpected error.", source: :ezllm, message: message,
                           guidance: hint || "This looks like a bug — please report it.",
                           provider: nil, status_code: nil, request_id: request_id, resets_at: nil)
      end
    end

    def clean_provider_message(message)
      message.to_s.sub(/\A\[[^\]]+\]\s*/, "").strip
    end

    def infer_source(err)
      msg = err.message.to_s.downcase
      if err.is_a?(::SocketError) || err.is_a?(Errno::ECONNREFUSED) ||
         err.is_a?(Errno::ETIMEDOUT) || err.is_a?(Errno::ECONNRESET) ||
         msg.include?("fetch failed") || msg.include?("network request failed")
        return :network
      end
      if msg.include?("not logged in") || msg.include?("token exchange failed") ||
         msg.include?("token refresh failed") || msg.include?("invalid_grant")
        return :auth
      end

      :ezllm
    end

    def provider_guidance(provider, message, status_code)
      name = provider ? provider_display_name(provider) : "the provider"
      status = provider ? PROVIDER_STATUS_URL[provider.to_s] : nil
      lower = message.to_s.downcase

      if status_code == 401 || lower.include?("unauthorized") || lower.include?("invalid api key")
        return "Authentication failed with #{name}. Refresh your credentials."
      end
      if lower.include?("overloaded") || lower.include?("engine_overloaded")
        return "#{name}'s servers are overloaded right now. Retry in a moment."
      end
      if lower.include?("insufficient balance") || lower.include?("quota exceeded") ||
         lower.include?("recharge") || lower.include?("no resource package")
        return "Your #{name} account has a billing or quota issue — check your balance."
      end
      if status_code == 429 || lower.include?("rate limit") || lower.include?("too many requests")
        return "#{name} rate limit hit. Wait a moment then retry."
      end
      if lower.include?("context_length_exceeded") || lower.include?("prompt is too long")
        return "Context window for this #{name} model is full. Compact history or start fresh."
      end

      if status
        "This is an error from #{name}, not EZLLM. Retry — if it persists, check #{status}."
      else
        "This is an error from #{name}, not EZLLM. Retry — if it persists, try a different model."
      end
    end

    def format_reset_time(resets_at)
      Time.at(resets_at).strftime("%-I:%M %p")
    end
  end
end
