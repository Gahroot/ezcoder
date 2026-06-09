# frozen_string_literal: true

require "rails/engine"

module EZAgentRails
  # The mountable engine. Isolating the namespace gives the models a
  # `ez_agent_rails_` table prefix and keeps routes/helpers scoped under
  # `EZAgentRails::`. Mount it in the host app with:
  #
  #   mount EZAgentRails::Engine => "/ez_agent"
  class Engine < ::Rails::Engine
    isolate_namespace EZAgentRails

    config.generators do |g|
      g.test_framework :rspec
    end

    # Teach Rails' zeitwerk autoloaders that the `ez_agent_rails/` namespace
    # directory maps to `EZAgentRails` (the default inflector would expect
    # `EzAgentRails` and fail to find the engine's app/ constants).
    #
    # The `EZ` acronym is also registered with ActiveSupport's inflector so that
    # NON-zeitwerk camelization — most importantly the router resolving a
    # `ez_agent_rails/runs` controller path to `EZAgentRails::RunsController` —
    # produces the same constant name. Without it routing 500s on an
    # `uninitialized constant EzAgentRails`.
    initializer "ez_agent_rails.inflections", before: :set_autoload_paths do
      Rails.autoloaders.each do |autoloader|
        autoloader.inflector.inflect("ez_agent_rails" => "EZAgentRails")
      end
      ActiveSupport::Inflector.inflections(:en) do |inflect|
        inflect.acronym "EZ"
      end
    end
  end
end
