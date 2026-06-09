# frozen_string_literal: true

module EZAgentRails
  # Raw-event fallback transport.
  #
  # Turbo's `turbo_stream_from run` (backed by {Turbo::StreamsChannel}) is the
  # PRIMARY path: it delivers ready-to-insert HTML so a browser needs no custom
  # JS. This channel is the FALLBACK for non-Hotwire consumers (a native app, a
  # CLI, a server-to-server bridge) that want the structured {EZAgent::Event}
  # stream as JSON instead of rendered markup.
  #
  # Subscribe with the run id:
  #
  #   consumer.subscriptions.create({ channel: "EZAgentRails::RunChannel", run_id: 42 })
  #
  # The {Broadcaster} publishes one JSON message per event (see
  # {EZAgentRails::EventPayload}) to {.stream_name_for} for the same run.
  class RunChannel < ActionCable::Channel::Base
    # Subscribe the client to its run's raw event stream, or reject if the run id
    # is missing/unknown (so a bad subscription fails fast rather than hanging).
    def subscribed
      run = EZAgentRails::Run.find_by(id: params[:run_id])
      return reject unless run

      stream_from self.class.stream_name_for(run)
    end

    # The Action Cable broadcasting name for a run's raw JSON event stream. Kept
    # distinct from Turbo's per-run stream (which carries HTML) so the two
    # transports never cross-contaminate.
    #
    # @param run [EZAgentRails::Run, #id, Integer]
    # @return [String]
    def self.stream_name_for(run)
      id = run.respond_to?(:id) ? run.id : run
      "ez_agent_rails:run:#{id}:events"
    end
  end
end
