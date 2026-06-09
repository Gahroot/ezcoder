# frozen_string_literal: true

require_relative "lib/ez_agent_rails/version"

Gem::Specification.new do |spec|
  spec.name = "ez_agent-rails"
  spec.version = EZAgentRails::VERSION
  spec.authors = ["EZ Agent"]
  spec.summary = "Rails engine adapter for the ez_agent framework."
  spec.description = <<~DESC
    ez_agent-rails wraps the framework-agnostic ez_agent loop in a mountable
    Rails engine: ActiveRecord persistence for conversations, messages, and
    runs; a configurable per-tenant credentials resolver; an install generator
    that copies the migration, an initializer, and mounts the engine. It also
    ships an off-request RunJob plus a Turbo/Hotwire broadcaster and Action Cable
    channel that stream agent events to the browser live. Depends on ez_agent,
    rails, and turbo-rails — bring your own tools.
  DESC
  spec.homepage = "https://github.com/Gahroot/ezcoder"
  spec.license = "MIT"

  spec.required_ruby_version = ">= 3.2"

  spec.files = Dir["lib/**/*", "app/**/*", "config/**/*", "README.md", "LICENSE"]
  spec.require_paths = ["lib"]

  spec.add_dependency "ez_agent", ">= 0.1.0"
  spec.add_dependency "rails", ">= 7.1"
  spec.add_dependency "turbo-rails", ">= 1.4"

  spec.metadata["rubygems_mfa_required"] = "true"
end
