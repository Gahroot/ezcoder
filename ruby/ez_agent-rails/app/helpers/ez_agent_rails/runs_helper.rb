# frozen_string_literal: true

module EZAgentRails
  # View-side counterpart to {EZAgentRails::DomTargets}: gives templates the same
  # element ids the {Broadcaster} aims its append/replace broadcasts at, so the
  # containers a page renders match what the live stream updates.
  module RunsHelper
    def run_stream_target(run)
      DomTargets.stream(run)
    end

    def run_tools_target(run)
      DomTargets.tools(run)
    end

    def run_status_target(run)
      DomTargets.status(run)
    end

    def run_confirmation_target(run, confirmation)
      DomTargets.confirmation_frame(run, confirmation.id)
    end

    # Engine URL helpers resolved through the mounted Engine's route set, so the
    # returned paths carry the host's mount prefix (e.g. `/ez_agent/...`) whether
    # they are built in an engine request OR in an out-of-band Turbo broadcast
    # (rendered via the host's ApplicationController, where the engine's own
    # `*_path` helpers are not in scope). Used by the confirm partial's buttons.
    def ez_agent_routes
      EZAgentRails::Engine.routes.url_helpers
    end
  end
end
