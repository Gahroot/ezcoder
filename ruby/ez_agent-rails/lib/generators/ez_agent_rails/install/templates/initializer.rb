# frozen_string_literal: true

# Configuration for the ez_agent-rails engine. See EZAgentRails::Configuration.
EZAgentRails.configure do |config|
  # Default provider + model handed to EZAgent::Loop.
  config.default_provider = :anthropic
  config.default_model    = "claude-sonnet-4-20250514"

  # Per-tenant credentials resolver: `->(provider, context) { { api_key:, ... } }`.
  # The default reads Rails.application.credentials[provider][:api_key] then the
  # `<PROVIDER>_API_KEY` env var. Override to scope keys per account/tenant:
  #
  #   config.credentials_resolver = lambda do |provider, context|
  #     account = context&.fetch(:account, nil)
  #     { api_key: account&.api_key_for(provider) || ENV["#{provider.to_s.upcase}_API_KEY"] }
  #   end

  # Tool classes (EZAgent::Tool subclasses) exposed to the loop.
  # config.tools = [MyApp::Tools::SearchDocs]

  # Feature toggles.
  config.fence_untrusted = false

  # Human-in-the-loop approval gate. When true, RunJob wires an
  # EZAgentRails::RailsApprovalGate into the loop so any tool that called
  # `requires_confirmation!` parks a EZAgentRails::ToolConfirmation row and BLOCKS
  # the background run until a user POSTs a decision to
  # /confirmations/:id (Approve / Deny / Always). A parked run can also be stopped
  # with POST /runs/:id/stop. Off by default — gating is a deliberate opt-in.
  config.approval_enabled = false

  # How long the gate blocks on a pending confirmation: poll cadence and the
  # hard timeout after which an unanswered prompt is denied (so a run can never
  # hang forever waiting on a human).
  # config.approval_poll_interval = 0.5  # seconds between polls
  # config.approval_timeout       = 300  # seconds before auto-deny
end
