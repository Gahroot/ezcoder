# frozen_string_literal: true

ENV["RAILS_ENV"] ||= "test"

require "fileutils"
require "spec_helper"
require_relative "dummy/config/environment"

abort("Rails is running in #{Rails.env}, refusing to run specs.") unless Rails.env.test?

require "rspec/rails"

# Shared spec support (scripted provider, etc.).
Dir[File.join(__dir__, "support", "**", "*.rb")].sort.each { |f| require f }

# Build the schema for the file-backed SQLite database by running the engine's
# migration against the test connection. Keeps the dummy app a real, migratable
# Rails app rather than a hand-maintained schema dump.
#
# The DB is a file (see config/database.yml) so the HITL specs can share rows
# across the RunJob thread and the resolving request thread. Start every run from
# a fresh file so a schema change (e.g. a new column) is always picked up, then
# enable WAL so the polling reader and the resolving writer don't deadlock.
ActiveRecord::Migration.verbose = false
ActiveRecord::Base.connection_pool.disconnect!
db_path = Dummy::Application.root.join("db", "test.sqlite3")
%w[ -wal -shm].each { |suffix| FileUtils.rm_f("#{db_path}#{suffix}") }
FileUtils.rm_f(db_path)
migration_paths = [Dummy::Application.root.join("db/migrate").to_s]
ActiveRecord::MigrationContext.new(migration_paths).migrate
ActiveRecord::Base.connection.execute("PRAGMA journal_mode=WAL")

RSpec.configure do |config|
  config.use_transactional_fixtures = true
  config.infer_spec_type_from_file_location!
  config.filter_rails_from_backtrace!
end
