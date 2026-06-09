# frozen_string_literal: true

module EZLLM
  # Immutable, validated description of one streaming call. Built by EZLLM.stream
  # and consumed by providers. Credentials (`api_key`, `base_url`, `account_id`,
  # `project_id`) are carried per call — there is no global key state, so a host
  # can serve many tenants/providers concurrently. Mirrors StreamOptions.
  Request = Data.define(
    :provider, :model, :messages, :tools, :tool_choice, :server_tools,
    :max_tokens, :temperature, :top_p, :stop, :thinking,
    :api_key, :base_url, :account_id, :project_id,
    :cache_retention, :prompt_cache_key, :service_tier,
    :web_search, :compaction, :clear_tool_uses,
    :supports_images, :supports_video, :streaming,
    :user_agent, :default_headers, :cancellation
  ) do
    def initialize(provider:, model:, messages:,
                   tools: nil, tool_choice: nil, server_tools: nil,
                   max_tokens: nil, temperature: nil, top_p: nil, stop: nil, thinking: nil,
                   api_key: nil, base_url: nil, account_id: nil, project_id: nil,
                   cache_retention: nil, prompt_cache_key: nil, service_tier: nil,
                   web_search: nil, compaction: nil, clear_tool_uses: nil,
                   supports_images: nil, supports_video: nil, streaming: nil,
                   user_agent: nil, default_headers: nil, cancellation: nil)
      super
    end

    # Return a copy with the given fields replaced (providers use this to inject
    # default base URLs, force non-streaming fallback, etc.).
    def merge(**overrides)
      with(**overrides)
    end

    # Streaming is on unless explicitly disabled (matches StreamOptions default).
    def streaming?
      streaming != false
    end
  end
end
