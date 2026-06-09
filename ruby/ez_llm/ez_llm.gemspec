# frozen_string_literal: true

require_relative "lib/ez_llm/version"

Gem::Specification.new do |spec|
  spec.name = "ez_llm"
  spec.version = EZLLM::VERSION
  spec.authors = ["EZ Agent"]
  spec.summary = "Unified, framework-agnostic LLM streaming + tool-calling for Ruby."
  spec.description = <<~DESC
    ez_llm is a standalone, dependency-light Ruby port of @prestyj/ai: a unified
    streaming API across Anthropic, OpenAI, Gemini, and every OpenAI-compatible
    provider (Moonshot/Kimi, GLM, MiniMax, Xiaomi/MiMo, DeepSeek, OpenRouter,
    Qwen). Streaming + non-streaming transport, a param DSL that compiles to JSON
    Schema, a model registry, and structured provider errors — with zero
    framework dependencies. Credentials are passed per call (per-tenant safe).
  DESC
  spec.homepage = "https://github.com/Gahroot/ezcoder"
  spec.license = "MIT"

  # Floor at 3.2: the lowest Ruby with Data.define (our value-object mechanism).
  spec.required_ruby_version = ">= 3.2"

  spec.files = Dir["lib/**/*.rb", "README.md", "LICENSE"]
  spec.require_paths = ["lib"]

  # Zeitwerk is a zero-dependency pure-Ruby autoloader — not a framework. Core
  # otherwise relies only on the standard library (net/http, json).
  spec.add_dependency "zeitwerk", "~> 2.6"

  spec.metadata["rubygems_mfa_required"] = "true"
end
