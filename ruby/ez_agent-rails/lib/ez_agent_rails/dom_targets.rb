# frozen_string_literal: true

module EZAgentRails
  # The DOM element ids the live-run UI is wired around. Both the Broadcaster
  # (server side, computing broadcast targets) and the view helpers (client side,
  # rendering the container elements) resolve ids through here so the append /
  # replace targets always line up with the elements on the page.
  #
  # All ids are derived from the run's `dom_id` (e.g. `ez_agent_rails_run_42`) so
  # they are unique per run and stable across a run's lifetime.
  module DomTargets
    module_function

    # The run's base dom id, e.g. `ez_agent_rails_run_42`.
    def dom_id(run)
      ActionView::RecordIdentifier.dom_id(run)
    end

    # Wrapper element for the whole run.
    def root(run)
      dom_id(run)
    end

    # Where streamed assistant text / thinking deltas are appended.
    def stream(run)
      "#{dom_id(run)}_stream"
    end

    # Container the per-tool frames are appended into.
    def tools(run)
      "#{dom_id(run)}_tools"
    end

    # The frame for a single tool call; replaced in place when the call ends.
    def tool_frame(run, tool_call_id)
      "#{dom_id(run)}_tool_#{tool_call_id}"
    end

    # The frame for a single human-in-the-loop confirmation prompt; appended when
    # the gate parks and replaced in place when the user records a decision.
    def confirmation_frame(run, confirmation_id)
      "#{dom_id(run)}_confirmation_#{confirmation_id}"
    end

    # The status line (retry / error / done updates replace this element).
    def status(run)
      "#{dom_id(run)}_status"
    end

    # The action button area (Stop while running, cleared after terminal states).
    def actions(run)
      "#{dom_id(run)}_actions"
    end

    # ── Conversation-level targets ────────────────────────

    # The messages container in the conversation show view.
    def messages(conversation)
      "#{ActionView::RecordIdentifier.dom_id(conversation)}_messages"
    end

    # The streaming message placeholder inside the messages container.
    # During a run, text deltas are appended here via conversation-level
    # Turbo Stream broadcasts. On completion the placeholder is replaced
    # with the persisted message.
    def streaming_message(conversation)
      "#{ActionView::RecordIdentifier.dom_id(conversation)}_streaming_message"
    end
  end
end
