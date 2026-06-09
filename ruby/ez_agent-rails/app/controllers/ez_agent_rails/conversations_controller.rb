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

    # GET /conversations — sidebar + empty state (no conversation selected).
    def index
      @conversations = Conversation.includes(:messages).order(updated_at: :desc)
      @provider_status = build_provider_status
    end

    # GET /conversations/:id — sidebar + the live chat page.
    def show
      @conversation = Conversation.includes(:messages).find(params[:id])
      # The most recent run (if any) is rendered into the active-run frame so a
      # reload re-subscribes to an in-flight run and re-shows pending prompts.
      @run = @conversation.runs.order(:created_at, :id).last
      @conversations = Conversation.includes(:messages).order(updated_at: :desc)

      # Provider/model dropdown data
      @available_providers = EZLLM::ProviderRegistry.list
      @default_provider = EZAgentRails.configuration.default_provider.to_s
      @default_model = EZAgentRails.configuration.default_model
      @models_by_provider = build_models_by_provider
    end

    # POST /conversations
    def create
      @conversation = Conversation.create!(conversation_params)
      redirect_to conversation_path(@conversation)
    end

    # DELETE /conversations/:id
    def destroy
      @conversation = Conversation.find(params[:id])
      @conversation.destroy
      @conversations = Conversation.includes(:messages).order(updated_at: :desc)

      respond_to do |format|
        format.turbo_stream { render :destroy }
        format.html { redirect_to conversations_path }
      end
    end

    private

    def conversation_params
      params.fetch(:conversation, {}).permit(:title)
    end

    # Build provider status array for the welcome screen cards.
    def build_provider_status
      icons = {
        "anthropic" => "circle", "openai" => "circle", "gemini" => "circle",
        "moonshot" => "moon", "glm" => "box", "minimax" => "diamond",
        "xiaomi" => "smartphone", "deepseek" => "anchor", "openrouter" => "shuffle"
      }
      EZLLM::ProviderRegistry.list.map do |provider|
        creds = EZAgentRails.credentials_for(provider)
        configured = creds[:api_key].present?
        models = EZLLM::ModelRegistry.for_provider(provider)
        {
          name: provider.to_s,
          display_name: provider.to_s.titleize,
          icon: icons[provider.to_s] || "bot",
          configured: configured,
          model_count: models.length
        }
      end
    end

    # Build a JSON-safe hash of provider => [{ id, name }] for the dropdown.
    def build_models_by_provider
      @available_providers.each_with_object({}) do |provider, hash|
        hash[provider.to_s] = EZLLM::ModelRegistry.for_provider(provider).map do |m|
          { id: m.id, name: m.name }
        end
      end
    end
  end
end
