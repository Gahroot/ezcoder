# frozen_string_literal: true

require_relative "lib/ez_agent/version"

Gem::Specification.new do |spec|
  spec.name = "ez_agent"
  spec.version = EZAgent::VERSION
  spec.authors = ["EZ Agent"]
  spec.summary = "A framework-agnostic, streaming, tool-calling agent loop for Ruby."
  spec.description = <<~DESC
    ez_agent is a standalone Ruby port of @prestyj/agent plus media-master's
    production hardening: a multi-turn agent loop with tool execution, fault
    isolation, timeouts, loop recovery (overload/stall/empty/overflow/tool-
    pairing), tool-result truncation, an OPTIONAL human-in-the-loop approval
    gate, OPTIONAL untrusted-content fencing, and cooperative cancellation.
    Transport- and execution-context-agnostic: it yields events to a block and
    the consumer owns concurrency. Depends only on ez_llm.
  DESC
  spec.homepage = "https://github.com/Gahroot/ezcoder"
  spec.license = "MIT"

  spec.required_ruby_version = ">= 3.2"

  spec.files = Dir["lib/**/*.rb", "README.md", "LICENSE"]
  spec.require_paths = ["lib"]

  spec.add_dependency "ez_llm", ">= 0.1.0"
  spec.add_dependency "zeitwerk", "~> 2.6"

  spec.metadata["rubygems_mfa_required"] = "true"
end
