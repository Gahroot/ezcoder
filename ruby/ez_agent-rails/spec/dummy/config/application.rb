# frozen_string_literal: true

require_relative "boot"

require "rails"
require "active_record/railtie"
require "action_controller/railtie"
require "action_view/railtie"
require "active_job/railtie"
require "action_cable/engine"

# Hotwire/Turbo — its Rails::Engine must be loaded before the dummy app boots so
# its broadcasting + stream-name initializers run. The engine's Broadcaster
# drives `Turbo::StreamsChannel` for live agent events.
require "turbo-rails"

# The engine under test (pulls in ez_agent + ez_llm). Required explicitly rather
# than via Bundler.require so the dummy loads only the frameworks it needs.
require "ez_agent_rails"

module Dummy
  class Application < Rails::Application
    # No config.ru / Rakefile in this minimal dummy, so pin the root explicitly
    # rather than letting Rails infer it from the caller.
    config.root = File.expand_path("..", __dir__)
    config.load_defaults Rails::VERSION::STRING.to_f
    config.eager_load = false
    config.active_support.report_deprecations = false

    # ActionCable test adapter — no external pub/sub backend in specs.
    config.action_cable.disable_request_forgery_protection = true
  end
end
