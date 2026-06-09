# frozen_string_literal: true

module EZAgentRails
  # Process-wide settings for the engine. Holds the default provider/model, a
  # per-tenant credentials resolver, the tool registry, and feature toggles.
  # Sane defaults read from `Rails.application.credentials` then ENV, so a host
  # app can mount the engine with zero configuration and still authenticate.
  class Configuration
    # @return [Symbol] default provider passed to {EZAgent::Loop}
    attr_accessor :default_provider

    # @return [String] default model id passed to {EZAgent::Loop}
    attr_accessor :default_model

    # A callable `->(provider, context) { { api_key:, base_url:, ... } }` that
    # resolves per-call auth. `provider` is a Symbol; `context` is whatever the
    # caller threads through (e.g. the current tenant/account). Must return a
    # Hash (string or symbol keys; normalized by {EZAgentRails.credentials_for}).
    # @return [#call]
    attr_accessor :credentials_resolver

    # Tool classes/instances handed to {EZAgent::Loop}. The engine never mutates
    # this list; the host app registers its own {EZAgent::Tool} subclasses.
    # @return [Array]
    attr_accessor :tools

    # Wrap the output of tools marked `untrusted!` before it enters history.
    # @return [Boolean]
    attr_accessor :fence_untrusted

    # When true, {RunJob} wires a {EZAgentRails::RailsApprovalGate} into the loop
    # so gated tools (those that called `requires_confirmation!` or are named in a
    # policy) park a {ToolConfirmation} and block on a human decision. Off by
    # default — gating is a deliberate opt-in.
    # @return [Boolean]
    attr_accessor :approval_enabled

    # Seconds the approval gate waits between polls of a pending
    # {ToolConfirmation} row. Lower = snappier decisions, more DB reads.
    # @return [Numeric]
    attr_accessor :approval_poll_interval

    # Seconds the approval gate blocks on a pending confirmation before giving up
    # and denying, so an unanswered prompt can never hang the job forever.
    # @return [Numeric]
    attr_accessor :approval_timeout

    def initialize
      @default_provider = (ENV["EZ_AGENT_PROVIDER"] || "anthropic").to_sym
      @default_model = ENV["EZ_AGENT_MODEL"] || "claude-sonnet-4-20250514"
      @tools = []
      @fence_untrusted = false
      @approval_enabled = false
      @approval_poll_interval = EZAgentRails::RailsApprovalGate::DEFAULT_POLL_INTERVAL
      @approval_timeout = EZAgentRails::RailsApprovalGate::DEFAULT_TIMEOUT
      @credentials_resolver = method(:default_credentials)
    end

    private

    # Default resolver: look up an api_key (and optional base_url) for the
    # provider from Rails encrypted credentials first, then ENV. Returns a Hash;
    # missing values are simply omitted so the LLM layer can surface its own
    # "missing credentials" error.
    def default_credentials(provider, _context = nil)
      creds = {}
      api_key = lookup(provider, :api_key) || ENV["#{provider.to_s.upcase}_API_KEY"]
      base_url = lookup(provider, :base_url) || ENV["#{provider.to_s.upcase}_BASE_URL"]
      creds[:api_key] = api_key if api_key
      creds[:base_url] = base_url if base_url
      creds
    end

    # Dig into `Rails.application.credentials` for `provider.key`, guarding
    # against environments where Rails (or the credentials) aren't present.
    def lookup(provider, key)
      return nil unless defined?(Rails) && Rails.respond_to?(:application)

      app = Rails.application
      return nil unless app&.respond_to?(:credentials)

      app.credentials.dig(provider.to_sym, key)
    rescue StandardError
      nil
    end
  end
end
