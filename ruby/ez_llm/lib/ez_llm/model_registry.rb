# frozen_string_literal: true

module EZLLM
  # Registry of every provider/model the framework ships, with context windows,
  # output caps, thinking levels, and image/video capabilities. Consumers read
  # capability flags (supports_images/supports_video) to pass the right
  # downgrade hints into a stream, and context windows to drive compaction.
  #
  # Port of packages/cli/src/core/model-registry.ts.
  module ModelRegistry
    MB = 1024 * 1024

    # One model's capabilities. `max_video_bytes` is only meaningful when
    # `supports_video` is true (per-provider transport delivery cap).
    Model = Data.define(
      :id, :name, :provider, :context_window, :codex_context_window,
      :max_output_tokens, :supports_thinking, :supports_images, :supports_video,
      :max_video_bytes, :cost_tier, :max_thinking_level
    ) do
      def initialize(id:, name:, provider:, context_window:, max_output_tokens:,
                     supports_thinking:, supports_images:, supports_video:,
                     cost_tier:, max_thinking_level:,
                     codex_context_window: nil, max_video_bytes: nil)
        super
      end
    end

    # Default video payload cap (bytes) when a video model doesn't declare one.
    DEFAULT_MAX_VIDEO_BYTES = 20 * MB

    MODELS = [
      # ── Anthropic ──────────────────────────────────────────
      Model.new(id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: :anthropic,
                context_window: 1_000_000, max_output_tokens: 128_000,
                supports_thinking: true, supports_images: true, supports_video: false,
                cost_tier: :high, max_thinking_level: :max),
      Model.new(id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: :anthropic,
                context_window: 1_000_000, max_output_tokens: 64_000,
                supports_thinking: true, supports_images: true, supports_video: false,
                cost_tier: :medium, max_thinking_level: :max),
      Model.new(id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: :anthropic,
                context_window: 200_000, max_output_tokens: 64_000,
                supports_thinking: true, supports_images: true, supports_video: false,
                cost_tier: :low, max_thinking_level: :high),
      # ── OpenAI (Codex) ─────────────────────────────────────
      Model.new(id: "gpt-5.5", name: "GPT-5.5", provider: :openai,
                context_window: 1_050_000, codex_context_window: 272_000,
                max_output_tokens: 128_000, supports_thinking: true,
                supports_images: true, supports_video: false,
                cost_tier: :high, max_thinking_level: :xhigh),
      Model.new(id: "gpt-5.4", name: "GPT-5.4", provider: :openai,
                context_window: 1_050_000, codex_context_window: 272_000,
                max_output_tokens: 128_000, supports_thinking: true,
                supports_images: true, supports_video: false,
                cost_tier: :high, max_thinking_level: :xhigh),
      Model.new(id: "gpt-5.4-mini", name: "GPT-5.4 Mini", provider: :openai,
                context_window: 400_000, max_output_tokens: 128_000,
                supports_thinking: true, supports_images: true, supports_video: false,
                cost_tier: :low, max_thinking_level: :xhigh),
      Model.new(id: "gpt-5.3-codex", name: "GPT-5.3 Codex", provider: :openai,
                context_window: 400_000, max_output_tokens: 128_000,
                supports_thinking: true, supports_images: true, supports_video: false,
                cost_tier: :high, max_thinking_level: :xhigh),
      # ── Gemini ─────────────────────────────────────────────
      Model.new(id: "gemini-3.1-flash-lite-preview", name: "Gemini 3.1 Flash Lite Preview",
                provider: :gemini, context_window: 1_048_576, max_output_tokens: 65_536,
                supports_thinking: true, supports_images: true, supports_video: true,
                max_video_bytes: 20 * MB, cost_tier: :low, max_thinking_level: :high),
      Model.new(id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", provider: :gemini,
                context_window: 1_048_576, max_output_tokens: 65_536,
                supports_thinking: true, supports_images: true, supports_video: true,
                max_video_bytes: 20 * MB, cost_tier: :low, max_thinking_level: :high),
      # ── Moonshot (Kimi) ────────────────────────────────────
      Model.new(id: "kimi-k2.6", name: "Kimi K2.6", provider: :moonshot,
                context_window: 262_144, max_output_tokens: 262_144,
                supports_thinking: true, supports_images: true, supports_video: true,
                max_video_bytes: 100 * MB, cost_tier: :medium, max_thinking_level: :high),
      # ── Z.AI (GLM) ─────────────────────────────────────────
      Model.new(id: "glm-5.1", name: "GLM-5.1", provider: :glm,
                context_window: 204_800, max_output_tokens: 131_072,
                supports_thinking: true, supports_images: false, supports_video: false,
                cost_tier: :medium, max_thinking_level: :high),
      Model.new(id: "glm-4.7", name: "GLM-4.7", provider: :glm,
                context_window: 200_000, max_output_tokens: 131_072,
                supports_thinking: true, supports_images: false, supports_video: false,
                cost_tier: :low, max_thinking_level: :high),
      Model.new(id: "glm-4.7-flash", name: "GLM-4.7 Flash", provider: :glm,
                context_window: 200_000, max_output_tokens: 131_072,
                supports_thinking: true, supports_images: false, supports_video: false,
                cost_tier: :low, max_thinking_level: :high),
      # ── MiniMax ────────────────────────────────────────────
      Model.new(id: "MiniMax-M3", name: "MiniMax M3", provider: :minimax,
                context_window: 1_000_000, max_output_tokens: 131_072,
                supports_thinking: true, supports_images: true, supports_video: true,
                max_video_bytes: 50 * MB, cost_tier: :medium, max_thinking_level: :high),
      # ── Xiaomi (MiMo) ──────────────────────────────────────
      Model.new(id: "mimo-v2.5-pro", name: "MiMo-V2.5-Pro", provider: :xiaomi,
                context_window: 1_000_000, max_output_tokens: 131_072,
                supports_thinking: true, supports_images: false, supports_video: false,
                cost_tier: :medium, max_thinking_level: :high),
      Model.new(id: "mimo-v2.5", name: "MiMo-V2.5", provider: :xiaomi,
                context_window: 1_000_000, max_output_tokens: 131_072,
                supports_thinking: true, supports_images: true, supports_video: true,
                max_video_bytes: 36 * MB, cost_tier: :low, max_thinking_level: :high),
      # ── DeepSeek ───────────────────────────────────────────
      Model.new(id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", provider: :deepseek,
                context_window: 1_048_576, max_output_tokens: 384_000,
                supports_thinking: true, supports_images: false, supports_video: false,
                cost_tier: :high, max_thinking_level: :xhigh),
      Model.new(id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", provider: :deepseek,
                context_window: 1_048_576, max_output_tokens: 384_000,
                supports_thinking: true, supports_images: false, supports_video: false,
                cost_tier: :low, max_thinking_level: :xhigh),
      # ── OpenRouter ─────────────────────────────────────────
      Model.new(id: "qwen/qwen3.6-plus", name: "Qwen3.6-Plus", provider: :openrouter,
                context_window: 1_000_000, max_output_tokens: 65_536,
                supports_thinking: true, supports_images: false, supports_video: false,
                cost_tier: :medium, max_thinking_level: :high)
    ].freeze

    DEFAULTS = {
      xiaomi: "mimo-v2.5-pro", openai: "gpt-5.5",
      gemini: "gemini-3.1-flash-lite-preview", glm: "glm-5.1", moonshot: "kimi-k2.6",
      minimax: "MiniMax-M3", deepseek: "deepseek-v4-pro", openrouter: "qwen/qwen3.6-plus",
      anthropic: "claude-sonnet-4-6"
    }.freeze

    module_function

    def all
      MODELS
    end

    def get(id)
      MODELS.find { |m| m.id == id }
    end

    def for_provider(provider)
      MODELS.select { |m| m.provider == provider.to_sym }
    end

    def default_model(provider)
      get(DEFAULTS.fetch(provider.to_sym, "claude-sonnet-4-6"))
    end

    # True when the request rides the OpenAI Codex transport (OpenAI + accountId).
    def codex_transport?(provider:, account_id: nil)
      provider.to_sym == :openai && !account_id.nil? && !account_id.to_s.empty?
    end

    def context_window(model_id, provider: nil, account_id: nil)
      model = get(model_id)
      return 200_000 unless model

      if codex_transport?(provider: provider, account_id: account_id) && model.codex_context_window
        return model.codex_context_window
      end

      model.context_window
    end

    # Max video payload (bytes) the model's transport accepts, or nil for models
    # without video support (callers skip the native-video path entirely).
    def video_byte_limit(model_id)
      model = get(model_id)
      return nil unless model&.supports_video

      model.max_video_bytes || DEFAULT_MAX_VIDEO_BYTES
    end

    # Strongest thinking level the model genuinely uses; "high" for unknowns.
    def max_thinking_level(model_id)
      get(model_id)&.max_thinking_level || :high
    end
  end
end
