# frozen_string_literal: true

require "rails/generators"
require "rails/generators/migration"
require "rails/generators/active_record"

module EZAgentRails
  module Generators
    # `rails g ez_agent_rails:install` — copies the migration, drops an
    # initializer that calls `EZAgentRails.configure`, and mounts the engine in
    # the host app's routes.
    class InstallGenerator < ::Rails::Generators::Base
      include ::ActiveRecord::Generators::Migration

      source_root File.expand_path("templates", __dir__)

      desc "Install ez_agent-rails: migration, initializer, and engine mount."

      def copy_migration
        migration_template "create_ez_agent_rails_tables.rb.tt",
                           "db/migrate/create_ez_agent_rails_tables.rb"
      end

      def copy_initializer
        template "initializer.rb", "config/initializers/ez_agent_rails.rb"
      end

      def mount_engine
        route 'mount EZAgentRails::Engine => "/ez_agent"'
      end

      private

      # `[7.1]`-style suffix so the generated migration pins the host's AR
      # version (matches what `rails g migration` produces).
      def migration_version
        "[#{ActiveRecord::VERSION::MAJOR}.#{ActiveRecord::VERSION::MINOR}]"
      end
    end
  end
end
