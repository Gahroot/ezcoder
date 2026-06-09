# frozen_string_literal: true

require "turbo/broadcastable/test_helper"

# Shared setup for specs that drive a real {EZAgent::Loop} against the in-process
# scripted provider and assert on the broadcasts it produces: configure the
# engine to use the `:fake` provider, register the scripted provider, and swap
# Action Cable's pubsub to the in-memory test adapter (RSpec doesn't run the
# Minitest lifecycle hooks that normally install it).
RSpec.shared_context "with scripted streaming" do
  include Turbo::Broadcastable::TestHelper

  around do |example|
    EZAgentRails.reset_configuration!
    FakeProvider.reset!
    FakeProvider.install!
    example.run
    EZAgentRails.reset_configuration!
    FakeProvider.reset!
  end

  before do
    EZAgentRails.configure do |c|
      c.default_provider = :fake
      c.default_model = "fake-1"
      c.credentials_resolver = ->(_provider, _context) { { api_key: "test-key" } }
    end

    @previous_pubsub = ActionCable.server.pubsub
    ActionCable.server.instance_variable_set(
      :@pubsub, ActionCable::SubscriptionAdapter::Test.new(ActionCable.server)
    )
  end

  after do
    ActionCable.server.instance_variable_set(:@pubsub, @previous_pubsub)
  end

  # Raw (JSON-decoded) Action Cable messages broadcast to a stream, without the
  # Minitest-only block form of `capture_broadcasts`.
  def raw_broadcasts(stream_name)
    broadcasts(stream_name).map { |m| ActiveSupport::JSON.decode(m) }
  end
end
