# frozen_string_literal: true

module EZLLM
  # Provider adapters + built-in registrations. Each registry entry resolves a
  # per-call default base URL and provider quirk, then delegates to the matching
  # adapter class. Mirrors the `providerRegistry.register(...)` block in stream.ts.
  module Providers
    GLM_BASE_URL = "https://api.z.ai/api/coding/paas/v4"
    XIAOMI_BASE_URL = "https://token-plan-sgp.xiaomimimo.com/v1"
    MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1"
    DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1"
    OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
    MINIMAX_BASE_URL = "https://api.minimax.io/anthropic"
    KIMI_CODE_USER_AGENT = "kimi-code-cli/1.0.11"

    module_function

    # Register every built-in provider. Idempotent — safe to call more than once.
    def register_builtin!
      ProviderRegistry.register(:anthropic) { |req, &cb| Anthropic.call(req, &cb) }
      ProviderRegistry.register(:openai) { |req, &cb| OpenAI.call(req, &cb) }
      ProviderRegistry.register(:gemini) { |req, &cb| Gemini.call(req, &cb) }

      ProviderRegistry.register(:xiaomi) do |req, &cb|
        OpenAICompatible.call(req.merge(base_url: req.base_url || XIAOMI_BASE_URL, web_search: false), &cb)
      end
      ProviderRegistry.register(:glm) do |req, &cb|
        OpenAICompatible.call(req.merge(base_url: req.base_url || GLM_BASE_URL), &cb)
      end
      ProviderRegistry.register(:deepseek) do |req, &cb|
        OpenAICompatible.call(req.merge(base_url: req.base_url || DEEPSEEK_BASE_URL), &cb)
      end
      ProviderRegistry.register(:openrouter) do |req, &cb|
        OpenAICompatible.call(req.merge(base_url: req.base_url || OPENROUTER_BASE_URL), &cb)
      end
      ProviderRegistry.register(:moonshot) do |req, &cb|
        base = req.base_url || MOONSHOT_BASE_URL
        headers = req.default_headers
        if base.include?("api.kimi.com")
          headers = { "User-Agent" => KIMI_CODE_USER_AGENT }.merge(headers || {})
        end
        OpenAICompatible.call(req.merge(base_url: base, default_headers: headers), &cb)
      end
      # MiniMax rides the Anthropic-compatible transport, minus Anthropic-only extras.
      ProviderRegistry.register(:minimax) do |req, &cb|
        Anthropic.call(req.merge(base_url: req.base_url || MINIMAX_BASE_URL,
                                 web_search: false, compaction: false,
                                 clear_tool_uses: false, server_tools: nil), &cb)
      end
    end
  end
end
