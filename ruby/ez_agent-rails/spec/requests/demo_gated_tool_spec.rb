# frozen_string_literal: true

require "rails_helper"

# End-to-end gated-tool APPROVE path driven entirely through the engine's real
# HTTP endpoints + the bundled demo controllers — the full web ⇄ background-job
# split:
#
#   1. a prompt is submitted via the demo ConversationsController/RunsController,
#   2. the RunJob blocks in a background thread on a pending ToolConfirmation,
#   3. a SEPARATE web request approves it through ToolConfirmationsController, and
#   4. the gated tool runs and the run finishes succeeded.
#
# Like spec/jobs/run_hitl_spec.rb this needs a file-backed DB visible across the
# two threads' connections, so transactional fixtures are off and rows are
# cleaned up by hand.
RSpec.describe "EZAgentRails demo gated tool", type: :request do
  self.use_transactional_tests = false

  around do |example|
    EZAgentRails.reset_configuration!
    FakeProvider.reset!
    FakeProvider.install!
    SpecGatedTool.reset!
    # `:test` so RunsController#create's `perform_later` only ENQUEUES — the spec
    # drives the job itself in a background thread (so it can block on the gate).
    previous_adapter = ActiveJob::Base.queue_adapter
    ActiveJob::Base.queue_adapter = :test
    example.run
  ensure
    ActiveJob::Base.queue_adapter = previous_adapter
    EZAgentRails.reset_configuration!
    FakeProvider.reset!
    SpecGatedTool.reset!
    EZAgentRails::ToolConfirmation.delete_all
    EZAgentRails::Message.delete_all
    EZAgentRails::Run.delete_all
    EZAgentRails::Conversation.delete_all
  end

  before do
    EZAgentRails.configure do |c|
      c.default_provider = :fake
      c.default_model = "fake-1"
      c.credentials_resolver = ->(_provider, _context) { { api_key: "test-key" } }
      c.tools = [SpecGatedTool]
      c.approval_enabled = true
      c.approval_poll_interval = 0.01
      c.approval_timeout = 5.0
    end

    @previous_pubsub = ActionCable.server.pubsub
    ActionCable.server.instance_variable_set(
      :@pubsub, ActionCable::SubscriptionAdapter::Test.new(ActionCable.server)
    )
  end

  after do
    ActionCable.server.instance_variable_set(:@pubsub, @previous_pubsub)
  end

  it "approves a parked confirmation through the controller and runs the gated tool" do
    FakeProvider.tool_call(id: "g1", name: "danger_write", args: { "path" => "report.txt" })
    FakeProvider.text("Done — the file was written.")

    # Start a conversation through the demo controller.
    post "/ez_agent/conversations", params: { conversation: { title: "Gated" } }
    conversation = EZAgentRails::Conversation.order(:id).last
    expect(conversation).to be_present

    # Submit the prompt: this enqueues the run; drive it in a background thread so
    # the job can BLOCK on the gate while this thread approves it.
    post "/ez_agent/conversations/#{conversation.id}/runs", params: { prompt: "write the report" }
    expect(response).to have_http_status(:ok)
    run = conversation.runs.last
    expect(run).to be_present

    thread, errors = drive_run_async(run.id, "write the report")

    # The gate parked a pending confirmation — surfaced as an Approve card.
    confirmation = wait_for_pending_confirmation(run)
    expect(confirmation).to be_present
    expect(confirmation.tool_name).to eq("danger_write")

    # The live run frame would render the Approve button; resolve it the same way
    # the button does — POST the decision to the real controller endpoint.
    post "/ez_agent/confirmations/#{confirmation.id}", params: { decision: "allow" }
    expect(response).to have_http_status(:no_content)

    join!(thread, errors)

    expect(confirmation.reload).to be_allow
    expect(SpecGatedTool.execution_count).to eq(1)
    expect(SpecGatedTool.executed_paths).to eq(["report.txt"])
    expect(run.reload).to be_succeeded
  end

  # ── helpers ──────────────────────────────────────────────

  # The demo's RunsController#create uses `perform_later`; here we drive the same
  # job inline in a background thread (its own connection) so it can block on the
  # gate while the spec thread records the decision.
  def drive_run_async(run_id, prompt)
    errors = Thread::Queue.new
    thread = Thread.new do
      ActiveRecord::Base.connection_pool.with_connection do
        EZAgentRails::RunJob.perform_now(run_id, prompt)
      end
    rescue Exception => e # rubocop:disable Lint/RescueException
      errors << e
    end
    thread.report_on_exception = false
    [thread, errors]
  end

  def join!(thread, errors)
    completed = thread.join(10)
    raise "RunJob thread did not finish (deadlock?)" unless completed
    raise errors.pop until errors.empty?
  end

  def wait_for_pending_confirmation(run)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 5
    while Process.clock_gettime(Process::CLOCK_MONOTONIC) < deadline
      row = EZAgentRails::ToolConfirmation.where(run_id: run.id, status: "pending").order(:id).first
      return row if row

      sleep 0.01
    end
    nil
  end
end
