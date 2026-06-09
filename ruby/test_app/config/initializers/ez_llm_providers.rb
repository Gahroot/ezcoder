# frozen_string_literal: true

# ──────────────────────────────────────────────────────────────────────────────
# EZLLM Provider Initializer
#
# Registers every provider from EZLLM's built-in provider registry and wires
# each one to a credentials resolver that reads its API key from the
# corresponding ENV variable: EZ_API_KEY_<PROVIDER>.
#
# The built-in providers are already registered by `Providers.register_builtin!`
# at ez_llm load time. This initializer layers a **credentials resolver** on top
# so the test app can call any provider without passing keys manually.
#
# ENV mapping (case-insensitive):
#   EZ_API_KEY_ANTHROPIC   → :anthropic
#   EZ_API_KEY_OPENAI      → :openai
#   EZ_API_KEY_GEMINI      → :gemini
#   EZ_API_KEY_MOONSHOT    → :moonshot
#   EZ_API_KEY_DEEPSEEK    → :deepseek
#   EZ_API_KEY_GLM         → :glm
#   EZ_API_KEY_OPENROUTER  → :openrouter
#   EZ_API_KEY_XIAOMI      → :xiaomi
#   EZ_API_KEY_MINIMAX     → :minimax
# ──────────────────────────────────────────────────────────────────────────────

# NOTE: ez_llm must be on $LOAD_PATH before this file is required.
# The runner scripts (run.rb, verify.rb) handle this.
require "ez_llm"

module TestApp
  # Provider configuration data — the single source of truth for this
  # initializer. Each entry maps a provider symbol to its ENV key suffix and
  # human-readable label.
  PROVIDER_CONFIGS = {
    anthropic:  { env_suffix: "ANTHROPIC",  display_name: "Anthropic" },
    openai:     { env_suffix: "OPENAI",     display_name: "OpenAI" },
    gemini:     { env_suffix: "GEMINI",     display_name: "Gemini" },
    moonshot:   { env_suffix: "MOONSHOT",   display_name: "Moonshot (Kimi)" },
    deepseek:   { env_suffix: "DEEPSEEK",   display_name: "DeepSeek" },
    glm:        { env_suffix: "GLM",        display_name: "GLM (Z.AI)" },
    openrouter: { env_suffix: "OPENROUTER", display_name: "OpenRouter" },
    xiaomi:     { env_suffix: "XIAOMI",     display_name: "Xiaomi (MiMo)" },
    minimax:    { env_suffix: "MINIMAX",    display_name: "MiniMax" }
  }.freeze

  class << self
    # The credentials resolver lambda. Given a provider symbol, returns a Hash
    # with :api_key resolved from ENV["EZ_API_KEY_<SUFFIX>"].
    #
    #   TestApp.credentials_for(:anthropic)
    #   # => { api_key: "sk-ant-..." }
    #
    # @param provider [Symbol, String] the provider name
    # @return [Hash] credentials hash suitable for EZLLM / EZAgent
    def credentials_for(provider)
      provider = provider.to_sym
      config = PROVIDER_CONFIGS[provider]

      unless config
        raise ArgumentError,
              "Unknown provider: #{provider.inspect}. " \
              "Registered: #{PROVIDER_CONFIGS.keys.join(', ')}"
      end

      env_key = "EZ_API_KEY_#{config[:env_suffix]}"
      api_key = ENV[env_key]

      creds = {}
      creds[:api_key] = api_key if api_key && !api_key.empty?
      creds
    end

    # Returns the credentials resolver lambda suitable for assignment to
    # EZAgentRails::Configuration#credentials_resolver or similar.
    #
    #   TestApp.credentials_resolver  # => #<Proc ...>
    def credentials_resolver
      ->(provider, _context = nil) { credentials_for(provider) }
    end

    # Convenience: list all registered providers with their metadata.
    # Merges the provider registry, model registry defaults, and our config.
    #
    # @return [Array<Hash>] sorted by provider name
    def registered_providers
      EZLLM::ProviderRegistry.list.sort.map do |name|
        default_model = EZLLM::ModelRegistry.default_model(name)
        config = PROVIDER_CONFIGS[name] || { env_suffix: name.to_s.upcase, display_name: name.to_s.capitalize }

        {
          name: name,
          display_name: config[:display_name],
          env_key: "EZ_API_KEY_#{config[:env_suffix]}",
          default_model_id: default_model&.id,
          default_model_name: default_model&.name,
          models: EZLLM::ModelRegistry.for_provider(name).map { |m| { id: m.id, name: m.name } }
        }
      end
    end
  end
end

# ── Wire the resolver into EZAgentRails if the engine is loaded ──────────────
if defined?(EZAgentRails)
  EZAgentRails.configure do |c|
    c.credentials_resolver = TestApp.credentials_resolver
  end
end

# ── Verify all built-in providers are registered ─────────────────────────────
_missing = (TestApp::PROVIDER_CONFIGS.keys - EZLLM::ProviderRegistry.list)
unless _missing.empty?
  warn "[ez_llm_providers] WARNING: expected providers not in registry: #{_missing.join(', ')}"
end
