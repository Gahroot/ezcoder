# frozen_string_literal: true

require "digest"

module EZAgentRails
  # Serves Turbo's prebuilt browser bundle straight from the `turbo-rails` gem so
  # the bundled demo UI runs with NO asset pipeline, importmap, or JS build step
  # — the only hard requirement the demo adds beyond the engine itself.
  #
  # `turbo-rails` ships a self-contained ES-module build of Turbo (it registers
  # the `<turbo-cable-stream-source>` custom element and an Action Cable consumer
  # and sets `window.Turbo`), so the demo layout loads it with a single
  # `<script type="module">`. Host apps that already ship Hotwire ignore this.
  #
  # All assets are served with a 1-year immutable cache, but the layout appends a
  # content digest (`?v=<digest>`) to each URL via {AssetsController.digest_for},
  # so a changed file produces a changed URL and the browser re-fetches it. This
  # is the same content-addressed cache-busting browsers rely on for fingerprinted
  # assets — without requiring an asset pipeline.
  class AssetsController < ApplicationController
    # This is a public, static asset meant to be loaded via a cross-origin
    # `<script>` tag, so opt out of Rails' same-origin JavaScript guard (which
    # otherwise 422s a non-XHR request for a `text/javascript` response).
    skip_forgery_protection

    # Logical asset name => absolute path on disk. Single source of truth for both
    # serving (the actions below) and fingerprinting (the layout helper).
    ASSETS = {
      "turbo" => -> { Turbo::Engine.root.join("app/assets/javascripts/turbo.min.js") },
      "provider_selector" => -> { Engine.root.join("app/javascript/controllers/provider_selector_controller.js") },
      "diagnostics" => -> { Engine.root.join("app/javascript/controllers/diagnostics_controller.js") }
    }.freeze

    # GET /turbo.js
    def turbo
      serve("turbo")
    end

    # GET /provider_selector.js
    def provider_selector_js
      serve("provider_selector")
    end

    # GET /diagnostics.js
    def diagnostics_js
      serve("diagnostics")
    end

    # Short content digest for an asset, used by the layout to fingerprint the
    # `<script src>` query string. In development files change between requests,
    # so the digest is recomputed each call (file reads are cheap and dev-only in
    # practice); in production the underlying files are immutable per deploy.
    def self.digest_for(name)
      path = ASSETS.fetch(name).call
      Digest::SHA1.file(path.to_s).hexdigest[0, 12]
    rescue StandardError
      nil
    end

    private

    def serve(name)
      path = ASSETS.fetch(name).call
      # immutable: the URL is content-addressed (see the layout's `?v=` digest), so
      # the bytes at a given URL never change — tell the browser it can skip
      # revalidation entirely for a year.
      expires_in 1.year, public: true, immutable: true
      send_file path, type: "text/javascript", disposition: "inline"
    end
  end
end
