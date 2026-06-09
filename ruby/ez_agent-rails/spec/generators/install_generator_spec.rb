# frozen_string_literal: true

require "rails_helper"
require "fileutils"
require "generators/ez_agent_rails/install/install_generator"

# Proves `rails g ez_agent_rails:install` produces a runnable setup: the
# migration that builds the engine's tables, the configure initializer, and the
# engine mount in the host's routes. Runs the real generator into a throwaway
# destination (rather than relying on rspec-rails' generator example group, which
# 7.x no longer ships) and asserts the emitted files.
RSpec.describe EZAgentRails::Generators::InstallGenerator do
  let(:destination) { Rails.root.join("tmp", "generator_spec") }

  before do
    FileUtils.rm_rf(destination)
    FileUtils.mkdir_p(destination.join("config"))
    # The mount step injects into an existing routes file.
    File.write(destination.join("config", "routes.rb"),
               "Rails.application.routes.draw do\nend\n")

    # Run quietly — suppress the generator's "create" log lines.
    silence_stream($stdout) do
      described_class.start([], destination_root: destination.to_s)
    end
  end

  # Minimal stdout silencer (ActiveSupport dropped the public Kernel#silence_stream).
  def silence_stream(stream)
    old = stream.dup
    stream.reopen(File::NULL)
    stream.sync = true
    yield
  ensure
    stream.reopen(old)
    old.close
  end

  after { FileUtils.rm_rf(destination) }

  it "copies a migration that creates all four engine tables" do
    migration = Dir[destination.join("db/migrate/*_create_ez_agent_rails_tables.rb").to_s].first
    expect(migration).to be_present

    body = File.read(migration)
    expect(body).to include("create_table :ez_agent_rails_conversations")
    expect(body).to include("create_table :ez_agent_rails_messages")
    expect(body).to include("create_table :ez_agent_rails_runs")
    expect(body).to include("create_table :ez_agent_rails_tool_confirmations")
    # The version suffix is pinned to the host's ActiveRecord (e.g. [8.1]).
    expect(body).to match(/ActiveRecord::Migration\[\d+\.\d+\]/)
  end

  it "drops a configure initializer" do
    initializer = destination.join("config", "initializers", "ez_agent_rails.rb")
    expect(File.exist?(initializer)).to be(true)

    body = File.read(initializer)
    expect(body).to include("EZAgentRails.configure")
    expect(body).to include("config.default_provider")
    expect(body).to include("config.approval_enabled")
  end

  it "mounts the engine in the host's routes" do
    routes = File.read(destination.join("config", "routes.rb"))
    expect(routes).to include('mount EZAgentRails::Engine => "/ez_agent"')
  end
end
