# frozen_string_literal: true

require "rails_helper"

# Drives the real {EZAgent::Loop} against an in-process SCRIPTED provider
# (registered into the EZLLM registry via {FakeProvider}) — no network — and
# proves the job persists the result, records usage, marks the run succeeded, and
# fans agent events out as Turbo Stream broadcasts.
RSpec.describe EZAgentRails::RunJob, type: :job do
  include_context "with scripted streaming"

  let(:conversation) { EZAgentRails::Conversation.create! }
  let(:run) { conversation.runs.create!(provider: "fake", model: "fake-1") }

  it "runs the loop, persists the result/usage, succeeds, and broadcasts events" do
    FakeProvider.text(
      "Hello from the agent",
      usage: EZLLM::Usage.new(input_tokens: 12, output_tokens: 7)
    )

    described_class.perform_now(run.id, "Summarize the repo")
    # Text deltas stream into the conversation; status/tool events into the run.
    conv_turbo = capture_turbo_stream_broadcasts(conversation)
    run_turbo  = capture_turbo_stream_broadcasts(run)

    run.reload
    conversation.reload

    # (a) the final assistant message is persisted to the conversation
    assistant = conversation.messages.where(role: "assistant").last
    expect(assistant).to be_present
    final_text = assistant.to_llm_message[:content]
                          .select { |b| b[:type] == "text" }
                          .map { |b| b[:text] }
                          .join
    expect(final_text).to eq("Hello from the agent")
    # the user prompt was appended before the run
    expect(conversation.messages.where(role: "user").last.content).to eq("Summarize the repo")

    # (b) usage is recorded on the Run
    expect(run.input_tokens).to eq(12)
    expect(run.output_tokens).to eq(7)

    # (c) the run ends succeeded (never stuck running)
    expect(run).to be_succeeded
    expect(run.error_message).to be_nil

    # (d) Turbo broadcasts: text_delta appends into the conversation,
    #     user_message appends into the conversation,
    #     agent_done replaces the status on the run.
    conv_actions = conv_turbo.map { |el| el["action"] }
    expect(conv_actions).to include("append")  # text_delta + user_message

    text_append = conv_turbo.find do |el|
      el["action"] == "append" && el["target"] == EZAgentRails::DomTargets.streaming_message(conversation)
    end
    expect(text_append).to be_present
    expect(text_append.to_s).to include("Hello from the agent")

    run_actions = run_turbo.map { |el| el["action"] }
    expect(run_actions).to include("replace") # agent_done replaced the status line

    done_status = run_turbo.find do |el|
      el["action"] == "replace" && el["target"] == EZAgentRails::DomTargets.status(run)
    end
    expect(done_status).to be_present
    expect(done_status.to_s).to include("Completed 1 turn")
  end

  it "marks the run failed (not stuck running) when the loop raises" do
    FakeProvider.error(StandardError.new("provider exploded"))

    expect do
      described_class.perform_now(run.id, "go")
    end.to raise_error(StandardError, /provider exploded/)

    run.reload
    expect(run).to be_failed
    expect(run.error_message).to match(/provider exploded/)
  end
end
