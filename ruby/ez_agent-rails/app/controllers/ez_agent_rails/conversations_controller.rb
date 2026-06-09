# frozen_string_literal: true

module EZAgentRails
  # The bundled demo chat UI. This is a reference implementation of a Hotwire
  # chat on top of the engine — list a conversation's messages, post a prompt
  # (which enqueues a {RunJob} via {RunsController#create}), and watch the run
  # stream live. Host apps can mount and use it as-is, copy it, or ignore it and
  # build their own UI against the same models/controllers.
  #
  # Opts into the engine's demo layout (the rest of the engine's endpoints return
  # bare fragments — see {ApplicationController}).
  class ConversationsController < ApplicationController
    layout "ez_agent_rails/application"

    # GET /conversations
    def index
      @conversations = Conversation.order(created_at: :desc)
    end

    # GET /conversations/:id — the live chat page.
    def show
      @conversation = Conversation.find(params[:id])
      # The most recent run (if any) is rendered into the active-run frame so a
      # reload re-subscribes to an in-flight run and re-shows pending prompts.
      @run = @conversation.runs.order(:created_at, :id).last
    end

    # POST /conversations
    def create
      @conversation = Conversation.create!(conversation_params)
      redirect_to conversation_path(@conversation)
    end

    private

    def conversation_params
      params.fetch(:conversation, {}).permit(:title)
    end
  end
end
