# frozen_string_literal: true

module EZLLM
  module Providers
    # First-party OpenAI (API-key path), riding the shared Chat Completions
    # transport. The OAuth/Codex Responses transport (accountId-gated) is a
    # future bespoke adapter; this subclass exists as the extension point and to
    # mirror the providers/openai.ts split.
    #
    # Port of providers/openai.ts (API-key branch).
    class OpenAI < OpenAICompatible
      def base_url
        request.base_url || "https://api.openai.com/v1"
      end
    end
  end
end
