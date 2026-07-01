import type { Message, StreamOptions } from "./types.js";
import { EZCoderAIError, VideoUnsupportedError } from "./errors.js";
import type { StreamResult } from "./utils/event-stream.js";
import { streamAnthropic } from "./providers/anthropic.js";
import { streamOpenAI } from "./providers/openai.js";
import { streamOpenAICodex } from "./providers/openai-codex.js";
import { streamGemini } from "./providers/gemini.js";
import { providerRegistry } from "./provider-registry.js";

/** Z.AI coding API endpoint — the primary endpoint for all GLM models. */
const GLM_CODING_BASE_URL = "https://api.z.ai/api/coding/paas/v4";

/**
 * User-Agent the Kimi For Coding endpoint requires to recognize ezcoder as a
 * coding agent. The endpoint gates solely on this header; the version is
 * overridable via KIMI_CODE_VERSION for forward compatibility.
 */
const KIMI_CODE_USER_AGENT = `kimi-code-cli/${process.env.KIMI_CODE_VERSION ?? "1.0.11"}`;

// ── Register built-in providers ────────────────────────────

providerRegistry.register("anthropic", {
  stream: (options) => streamAnthropic(options),
});

providerRegistry.register("xiaomi", {
  stream: (options) => {
    // Two distinct Xiaomi access products live under different hosts:
    //   - Token Plan subscription:  token-plan-sgp.xiaomimimo.com/v1
    //     (the default; serves mimo-v2.5-pro / mimo-v2.5 / flash)
    //   - Standard MiMo platform:   api.xiaomimimo.com/v1
    //     (serves the UltraSpeed beta, gated on a platform API key)
    // The UltraSpeed beta is ONLY on the platform host. A user logged in for
    // Token Plan carries a stored token-plan baseUrl that would misroute it
    // (the host replies "Not supported model"), so when UltraSpeed is the
    // target we ignore that token-plan default and use the platform host —
    // while still honoring an explicit non-token-plan override, so a wrong
    // host guess remains correctable via config.
    const TOKEN_PLAN_URL = "https://token-plan-sgp.xiaomimimo.com/v1";
    const PLATFORM_URL = "https://api.xiaomimimo.com/v1";
    let baseUrl: string;
    if (options.model === "mimo-v2.5-pro-ultraspeed") {
      baseUrl =
        options.baseUrl && options.baseUrl !== TOKEN_PLAN_URL ? options.baseUrl : PLATFORM_URL;
    } else {
      baseUrl = options.baseUrl ?? TOKEN_PLAN_URL;
    }
    return streamOpenAI({ ...options, baseUrl, webSearch: false });
  },
});

providerRegistry.register("openai", {
  stream: (options) => {
    // Use codex endpoint for OAuth tokens (have accountId)
    if (options.accountId) {
      return streamOpenAICodex(options);
    }
    return streamOpenAI(options);
  },
});

providerRegistry.register("gemini", {
  stream: (options) => streamGemini(options),
});

providerRegistry.register("glm", {
  stream: (options) =>
    streamOpenAI({
      ...options,
      baseUrl: options.baseUrl ?? GLM_CODING_BASE_URL,
    }),
});

providerRegistry.register("moonshot", {
  stream: (options) => {
    const baseUrl = options.baseUrl ?? "https://api.moonshot.ai/v1";
    // The Kimi For Coding (OAuth) endpoint at api.kimi.com gates access to
    // recognized coding agents and 403s any request whose `User-Agent` isn't a
    // known client (verified empirically: User-Agent alone is the gate). Inject
    // it centrally here so EVERY stream — agent loop, compaction, title-gen,
    // sub-agents — passes, instead of relying on each call site to thread
    // headers. Caller-provided headers still win on collision.
    const defaultHeaders = baseUrl.includes("api.kimi.com")
      ? { "User-Agent": KIMI_CODE_USER_AGENT, ...options.defaultHeaders }
      : options.defaultHeaders;
    return streamOpenAI({ ...options, baseUrl, defaultHeaders });
  },
});

providerRegistry.register("deepseek", {
  stream: (options) =>
    streamOpenAI({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.deepseek.com/v1",
    }),
});

providerRegistry.register("openrouter", {
  stream: (options) =>
    streamOpenAI({
      ...options,
      baseUrl: options.baseUrl ?? "https://openrouter.ai/api/v1",
    }),
});

providerRegistry.register("sakana", {
  // Sakana Fugu is a multi-agent system exposed as a standard LLM through the
  // OpenAI-compatible Sakana API. We ride the Chat Completions transport (the
  // Responses API is also offered). Fugu models only accept "high"/"xhigh"
  // reasoning effort — clamped centrally in toOpenAIReasoningEffort.
  stream: (options) =>
    streamOpenAI({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.sakana.ai/v1",
    }),
});

providerRegistry.register("minimax", {
  stream: (options) =>
    streamAnthropic({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.minimax.io/anthropic",
      // MiniMax's Anthropic-compatible API does not support Anthropic-specific
      // server tools (web_search), context_management, or server-side tools.
      webSearch: false,
      compaction: false,
      clearToolUses: false,
      serverTools: undefined,
    }),
});

// ── Public API ─────────────────────────────────────────────

/**
 * Unified streaming entry point. Returns a StreamResult that is both
 * an async iterable (for streaming events) and thenable (await for
 * the final response).
 *
 * Providers are resolved via the provider registry. Built-in providers
 * (anthropic, openai, glm, moonshot) are registered at module load.
 * Extensions can register custom providers via `providerRegistry.register()`.
 *
 * ```ts
 * // Stream events
 * for await (const event of stream({ provider: "anthropic", model: "claude-sonnet-5", messages })) {
 *   if (event.type === "text_delta") process.stdout.write(event.text);
 * }
 *
 * // Or just await the final message
 * const response = await stream({ provider: "openai", model: "gpt-4.1", messages });
 * ```
 */
export function stream(options: StreamOptions): StreamResult {
  const entry = providerRegistry.get(options.provider);
  if (!entry) {
    throw new EZCoderAIError(
      `Unknown provider: "${options.provider}". Registered: ${providerRegistry.list().join(", ")}`,
    );
  }
  // Fail fast with a clean capability error when video is in the request but the
  // model can't watch it (e.g. a video read under Kimi/Gemini left in history,
  // then the user switched to a text-only model). Without this, the provider
  // rejects the video block with an opaque "invalid tag 'video'" API error.
  if (options.supportsVideo !== true && messagesContainVideo(options.messages)) {
    throw new VideoUnsupportedError();
  }
  return entry.stream(options);
}

/** True if any message carries a video block, in user content or a tool result. */
function messagesContainVideo(messages: Message[]): boolean {
  for (const msg of messages) {
    if (typeof msg.content === "string" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type === "video") return true;
      if (part.type === "tool_result" && Array.isArray(part.content)) {
        if (part.content.some((block) => block.type === "video")) return true;
      }
    }
  }
  return false;
}
