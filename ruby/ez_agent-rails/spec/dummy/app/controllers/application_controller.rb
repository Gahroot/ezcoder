# frozen_string_literal: true

# Host-app base controller for the dummy. Turbo broadcasts render their partials
# through `ApplicationController.render`, so the dummy must define one for the
# engine's Broadcaster specs to exercise the real rendering path.
class ApplicationController < ActionController::Base
end
