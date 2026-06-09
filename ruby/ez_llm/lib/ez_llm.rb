# frozen_string_literal: true

require "zeitwerk"
require "json"
require "net/http" # ensures SocketError / Net::* constants exist for error classifiers

# EZLLM — a unified, framework-agnostic LLM streaming API for Ruby.
#
# Standalone port of @prestyj/ai: streaming + non-streaming transport across
# Anthropic, OpenAI, Gemini, and every OpenAI-compatible provider, a param DSL
# that compiles to JSON Schema, a model registry, and structured provider
# errors — with zero framework dependencies. Credentials are passed per call.
module EZLLM
  class << self
    attr_reader :loader
  end

  # Set up Zeitwerk autoloading with the acronyms this gem uses.
  @loader = Zeitwerk::Loader.for_gem
  @loader.inflector.inflect(
    "ez_llm" => "EZLLM",
    "sse" => "SSE",
    "http" => "HTTP",
    "openai" => "OpenAI",
    "openai_compatible" => "OpenAICompatible"
  )
  # version.rb defines a string constant (EZLLM::VERSION), not a class — Zeitwerk
  # would otherwise expect it to define EZLLM::Version. Load it manually.
  @loader.ignore("#{__dir__}/ez_llm/version.rb")
  @loader.setup

  require_relative "ez_llm/version"

  # Register the built-in providers (anthropic, openai, gemini, glm, moonshot,
  # deepseek, openrouter, xiaomi, minimax) at load time.
  Providers.register_builtin!

  # Unified streaming entry point. Resolves the provider from the registry,
  # fails fast on a capability mismatch (video in a non-video request), and
  # streams events to the given block while returning the final Response.
  #
  #   EZLLM.stream(provider: :anthropic, model: "claude-sonnet-4-6",
  #                messages: [{ role: "user", content: "hi" }],
  #                api_key: key) { |event| ... }
  #
  # @return [EZLLM::Response]
  def self.stream(provider:, model:, messages:, api_key: nil, **opts, &block)
    request = Request.new(provider: provider.to_sym, model: model, messages: messages,
                          api_key: api_key, **opts)
    entry = ProviderRegistry.get(request.provider)
    unless entry
      raise Error.new(
        %(Unknown provider: "#{request.provider}". Registered: #{ProviderRegistry.list.join(", ")})
      )
    end
    if request.supports_video != true && Types.messages_contain_video?(request.messages)
      raise VideoUnsupportedError.new
    end

    entry.call(request, &block)
  end

  # Eager-load everything (used in tests / CI to surface load errors).
  def self.eager_load!
    @loader.eager_load
  end
end
