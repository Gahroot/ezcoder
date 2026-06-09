# frozen_string_literal: true

require "ez_agent"

require_relative "ez_agent_rails/version"
require_relative "ez_agent_rails/configuration"
require_relative "ez_agent_rails/dom_targets"
require_relative "ez_agent_rails/event_payload"
require_relative "ez_agent_rails/cancellation"
require_relative "ez_agent_rails/rails_approval_gate"
require_relative "ez_agent_rails/engine"

# EZAgentRails — a mountable Rails engine that adapts the framework-agnostic
# {EZAgent::Loop} to a Rails application: ActiveRecord persistence for
# conversations / messages / runs, a configurable per-tenant credentials
# resolver, and an install generator. The engine's only hard dependencies are
# `ez_agent` and `rails`; the consumer still owns concurrency (run the loop in a
# job, a thread, or inline) and supplies the tools.
module EZAgentRails
  class << self
    # The process-wide configuration. Mutated via {configure}.
    def configuration
      @configuration ||= Configuration.new
    end

    # Configure the engine:
    #
    #   EZAgentRails.configure do |c|
    #     c.default_provider = :anthropic
    #     c.default_model    = "claude-sonnet-4-20250514"
    #     c.fence_untrusted  = true
    #   end
    #
    # @yieldparam config [Configuration]
    # @return [Configuration]
    def configure
      yield(configuration) if block_given?
      configuration
    end

    # Reset configuration to defaults (primarily for tests).
    def reset_configuration!
      @configuration = Configuration.new
    end

    # Resolve per-call credentials for a provider via the configured resolver.
    #
    # @param provider [Symbol, String, nil] defaults to the configured provider
    # @param context [Object, nil] arbitrary data threaded to the resolver
    # @return [Hash] e.g. { api_key:, base_url: }
    def credentials_for(provider = nil, context: nil)
      provider = (provider || configuration.default_provider).to_sym
      resolver = configuration.credentials_resolver
      result = resolver.call(provider, context)
      (result || {}).transform_keys(&:to_sym)
    end

    # Recursively symbolize Hash keys (Arrays are mapped, scalars pass through).
    # Used to rebuild framework message Hashes from JSON columns losslessly.
    #
    # @param value [Object]
    # @return [Object]
    def deep_symbolize(value)
      case value
      when Hash
        value.each_with_object({}) { |(k, v), h| h[k.to_sym] = deep_symbolize(v) }
      when Array
        value.map { |v| deep_symbolize(v) }
      else
        value
      end
    end
  end
end
