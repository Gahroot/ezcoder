# frozen_string_literal: true

Rails.application.routes.draw do
  mount EZAgentRails::Engine => "/ez_agent"

  # Action Cable endpoint so the bundled demo UI's Turbo Streams work when the
  # dummy app is booted as a real server. Specs use rack-test (no websocket).
  mount ActionCable.server => "/cable"
end
