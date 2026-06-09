# frozen_string_literal: true

module EZAgentRails
  # Base controller for the engine's own actions. Kept separate from the host
  # app's `ApplicationController` (which Turbo uses to render broadcast partials).
  #
  # Layout is OFF by default: the JSON/stream/partial endpoints (runs,
  # confirmations) must return bare fragments. The bundled demo chat controller
  # ({ConversationsController}) opts back into the engine's demo layout.
  class ApplicationController < ActionController::Base
    layout false
  end
end
