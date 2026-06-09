# frozen_string_literal: true

module EZAgentRails
  # Serves Turbo's prebuilt browser bundle straight from the `turbo-rails` gem so
  # the bundled demo UI runs with NO asset pipeline, importmap, or JS build step
  # — the only hard requirement the demo adds beyond the engine itself.
  #
  # `turbo-rails` ships a self-contained ES-module build of Turbo (it registers
  # the `<turbo-cable-stream-source>` custom element and an Action Cable consumer
  # and sets `window.Turbo`), so the demo layout loads it with a single
  # `<script type="module">`. Host apps that already ship Hotwire ignore this.
  class AssetsController < ApplicationController
    # This is a public, static asset meant to be loaded via a cross-origin
    # `<script>` tag, so opt out of Rails' same-origin JavaScript guard (which
    # otherwise 422s a non-XHR request for a `text/javascript` response).
    skip_forgery_protection

    # GET /turbo.js
    def turbo
      path = Turbo::Engine.root.join("app/assets/javascripts/turbo.min.js")
      expires_in 1.year, public: true
      send_file path, type: "text/javascript", disposition: "inline"
    end
  end
end
