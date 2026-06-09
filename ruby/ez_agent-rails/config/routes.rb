# frozen_string_literal: true

EZAgentRails::Engine.routes.draw do
  # The bundled demo chat UI. `index` lists conversations, `show` is the live
  # chat page (message history + prompt form + the active run's Turbo stream),
  # `create` starts a new conversation. The UI is Hotwire-only — no JS build.
  resources :conversations, only: [:index, :show, :create] do
    # Kick off a background run for a conversation, then show it. The page
    # subscribes to the run's Turbo stream (`turbo_stream_from run`) and watches
    # the RunJob's events arrive live.
    resources :runs, only: [:create]
  end

  # Serves Turbo's prebuilt JS straight from the `turbo-rails` gem so the demo
  # runs with zero asset pipeline / build step (the demo layout loads it as an
  # ES module). Host apps that already ship Hotwire don't need this.
  get "turbo.js", to: "assets#turbo", as: :turbo_js

  # `stop` stamps the run's `aborted_at` so a RunJob driving the loop in another
  # process cancels at its next boundary (cooperative cancellation).
  resources :runs, only: [:show] do
    member { post :stop }
  end

  # Record a human-in-the-loop decision for a parked gated tool call. POST (not
  # PATCH) so a plain `button_to` in the confirm card hits it; the blocked gate
  # polls the row and unblocks on the recorded status.
  post "confirmations/:id", to: "tool_confirmations#update", as: :confirmation
end
