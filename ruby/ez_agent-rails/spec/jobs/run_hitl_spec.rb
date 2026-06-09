# frozen_string_literal: true

require "rails_helper"
require "timeout"

# End-to-end human-in-the-loop + cooperative cancellation. These drive the REAL
# {EZAgent::Loop} (via {EZAgentRails::RunJob}) against the in-process scripted
# provider, with a confirmation-gated tool ({SpecGatedTool}).
#
# The whole point is the cross-process split: the RunJob blocks in a background
# THREAD inside the gate's `decide` callable while a separate web request records
# the decision. A file-backed SQLite DB (see rails_helper) makes the rows visible
# across the two threads' connections, so transactional fixtures are disabled
# here and rows are cleaned up by hand.
RSpec.describe EZAgentRails::RunJob, "human-in-the-loop", type: :request do
  self.use_transactional_tests = false

  around do |example|
    EZAgentRails.reset_configuration!
    FakeProvider.reset!
    FakeProvider.install!
    SpecGatedTool.reset!

    example.run
  ensure
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
      # Keep poll/timeout in milliseconds so specs finish fast.
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

  let(:conversation) { EZAgentRails::Conversation.create! }
  let(:run) { conversation.runs.create!(provider: "fake", model: "fake-1") }

  # (a) A gated tool call parks a pending confirmation; denying it via the
  # controller feeds the denial back so the run finishes WITHOUT running the tool.
  it "parks a pending confirmation and a controller deny finishes the run without running the tool" do
    FakeProvider.tool_call(id: "c1", name: "danger_write", args: { "path" => "report.txt" })
    FakeProvider.text("Understood, I won't write the file.")

    thread, errors = perform_run_async(run, "write the report")

    confirmation = wait_for_pending_confirmation(run)
    expect(confirmation).to be_present
    expect(confirmation.tool_name).to eq("danger_write")
    expect(confirmation.args).to eq("path" => "report.txt")

    post "/ez_agent/confirmations/#{confirmation.id}", params: { decision: "deny" }
    expect(response).to have_http_status(:no_content)

    join!(thread, errors)

    expect(confirmation.reload).to be_deny
    expect(SpecGatedTool.execution_count).to eq(0)
    expect(run.reload).to be_succeeded

    # The loop fed the denial back to the model, which took a SECOND turn and
    # answered without the tool. The engine persists only the final assistant
    # message, so its presence + content is the proof the run continued.
    assistant = conversation.messages.where(role: "assistant").last
    expect(assistant).to be_present
    expect(assistant.to_llm_message[:content].map { |b| b[:text] }.join)
      .to include("won't write the file")
  end

  # (b) Approving the parked confirmation runs the tool.
  it "runs the gated tool when the confirmation is approved via the controller" do
    FakeProvider.tool_call(id: "c1", name: "danger_write", args: { "path" => "report.txt" })
    FakeProvider.text("Done — the file was written.")

    thread, errors = perform_run_async(run, "write the report")

    confirmation = wait_for_pending_confirmation(run)
    post "/ez_agent/confirmations/#{confirmation.id}", params: { decision: "allow" }

    join!(thread, errors)

    expect(confirmation.reload).to be_allow
    expect(SpecGatedTool.execution_count).to eq(1)
    expect(SpecGatedTool.executed_paths).to eq(["report.txt"])
    expect(run.reload).to be_succeeded
  end

  # (c) Stopping the run mid-flight (durable aborted_at, from a different request)
  # halts the loop at the next boundary and marks the Run aborted.
  it "stops an in-flight run at the next boundary and marks it aborted" do
    FakeProvider.tool_call(id: "c1", name: "danger_write", args: { "path" => "report.txt" })

    thread, errors = perform_run_async(run, "write the report")

    # The run is parked on the gate — stop it from a separate web request.
    confirmation = wait_for_pending_confirmation(run)
    expect(confirmation).to be_present

    post "/ez_agent/runs/#{run.id}/stop"
    expect(response).to have_http_status(:no_content)

    join!(thread, errors)

    expect(run.reload).to be_aborted
    expect(run.aborted_at).to be_present
    expect(SpecGatedTool.execution_count).to eq(0)
  end

  # (d) A confirmation that is never answered times out → the gate denies and the
  # job COMPLETES rather than hanging. Single-threaded with a tiny timeout.
  it "denies and completes (does not hang) when the confirmation times out" do
    EZAgentRails.configuration.approval_timeout = 0.05
    EZAgentRails.configuration.approval_poll_interval = 0.01

    FakeProvider.tool_call(id: "c1", name: "danger_write", args: { "path" => "report.txt" })
    FakeProvider.text("No confirmation came, so I stopped.")

    Timeout.timeout(5) do
      EZAgentRails::RunJob.perform_now(run.id, "write the report")
    end

    expect(run.reload).to be_succeeded
    expect(SpecGatedTool.execution_count).to eq(0)
    confirmation = run.tool_confirmations.last
    expect(confirmation).to be_present
    expect(confirmation).to be_deny
  end

  # ── helpers ──────────────────────────────────────────────

  # Run the job in a background thread (its `decide` callable blocks), capturing
  # any exception so the spec can re-raise it after joining.
  def perform_run_async(run, prompt)
    errors = Thread::Queue.new
    thread = Thread.new do
      ActiveRecord::Base.connection_pool.with_connection do
        EZAgentRails::RunJob.perform_now(run.id, prompt)
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
    wait_until do
      EZAgentRails::ToolConfirmation.where(run_id: run.id, status: "pending").order(:id).first
    end
  end

  def wait_until(timeout = 5)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
    while Process.clock_gettime(Process::CLOCK_MONOTONIC) < deadline
      result = yield
      return result if result

      sleep 0.01
    end
    nil
  end
end
