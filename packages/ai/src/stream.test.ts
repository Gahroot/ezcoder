import { beforeEach, describe, expect, it, vi } from "vitest";
import { localWireModelId, stream } from "./stream.js";
import { EZCoderAIError } from "./errors.js";
import { providerRegistry } from "./provider-registry.js";
import { streamOpenAI } from "./providers/openai.js";
import type { StreamOptions } from "./types.js";

// The Xiaomi handler delegates to streamOpenAI; stub it so the host it picked
// is observable without opening a socket.
vi.mock("./providers/openai.js", () => ({
  streamOpenAI: vi.fn(() => ({ events: [], final: Promise.resolve() })),
}));

describe("localWireModelId", () => {
  it("strips the endpoint routing prefix so the server sees its own id", () => {
    expect(localWireModelId("local/ollama/qwen3-coder:30b")).toBe("qwen3-coder:30b");
    // Raw ids can contain slashes (vLLM serves HF repo ids).
    expect(localWireModelId("local/vllm/Qwen/Qwen3-32B")).toBe("Qwen/Qwen3-32B");
  });

  it("leaves non-local ids untouched", () => {
    expect(localWireModelId("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(localWireModelId("qwen/qwen3.6-plus")).toBe("qwen/qwen3.6-plus");
  });
});

describe("local provider", () => {
  it("refuses to stream without an endpoint instead of guessing a port", () => {
    expect(() =>
      stream({
        provider: "local",
        model: "local/ollama/qwen3-coder:30b",
        messages: [{ role: "user", content: "hi" }],
        apiKey: "local",
      }),
    ).toThrow(EZCoderAIError);
  });
});

describe("xiaomi host routing", () => {
  const TOKEN_PLAN = "https://token-plan-sgp.xiaomimimo.com/v1";
  const PLATFORM = "https://api.xiaomimimo.com/v1";

  const routedBaseUrl = (model: string, baseUrl?: string): string | undefined => {
    stream({
      provider: "xiaomi",
      model,
      messages: [{ role: "user", content: "hi" }],
      apiKey: "test-key",
      ...(baseUrl ? { baseUrl } : {}),
    });
    return vi.mocked(streamOpenAI).mock.calls.at(-1)?.[0]?.baseUrl;
  };

  beforeEach(() => {
    vi.mocked(streamOpenAI).mockClear();
  });

  it("sends Token Plan models to the Token Plan host by default", () => {
    expect(routedBaseUrl("mimo-v2.6-pro")).toBe(TOKEN_PLAN);
    expect(routedBaseUrl("mimo-v2.6-flash")).toBe(TOKEN_PLAN);
  });

  it("sends any UltraSpeed model to the platform host, which alone serves it", () => {
    expect(routedBaseUrl("mimo-v2.6-pro-ultraspeed")).toBe(PLATFORM);
    // Suffix-matched, so a future generation's SKU routes without a code change.
    expect(routedBaseUrl("mimo-v2.7-pro-ultraspeed")).toBe(PLATFORM);
  });

  it("overrides a stored Token Plan baseUrl for UltraSpeed rather than misrouting it", () => {
    // A Token Plan login persists that host on the credential. Sending
    // UltraSpeed there earns "Not supported model", so the default is ignored.
    expect(routedBaseUrl("mimo-v2.6-pro-ultraspeed", TOKEN_PLAN)).toBe(PLATFORM);
  });

  it("still honors an explicit non-Token-Plan override so a bad host stays fixable", () => {
    const custom = "https://mimo.example.test/v1";
    expect(routedBaseUrl("mimo-v2.6-pro-ultraspeed", custom)).toBe(custom);
    expect(routedBaseUrl("mimo-v2.6-pro", custom)).toBe(custom);
  });
});

describe("provider wire boundary", () => {
  it("strips provenance without cloning unrelated messages", () => {
    let captured: StreamOptions | undefined;
    const sentinel = new Error("captured");
    providerRegistry.register("wire-capture", {
      stream: (options) => {
        captured = options;
        throw sentinel;
      },
    });

    const plain = { role: "system" as const, content: "system" };
    const tagged = {
      role: "user" as const,
      content: "hello",
      provenance: {
        source: "human" as const,
        kind: "prompt" as const,
        visibility: "transcript" as const,
      },
    };

    try {
      expect(() =>
        stream({
          provider: "wire-capture" as StreamOptions["provider"],
          model: "test",
          messages: [plain, tagged],
        }),
      ).toThrow(sentinel);
      expect(captured?.messages[0]).toBe(plain);
      expect(captured?.messages[1]).toEqual({ role: "user", content: "hello" });
      expect(captured?.messages[1]).not.toHaveProperty("provenance");
      expect(tagged.provenance.source).toBe("human");
    } finally {
      providerRegistry.unregister("wire-capture");
    }
  });

  it("scrubs lone surrogates so the provider body stays valid JSON", () => {
    let captured: StreamOptions | undefined;
    const sentinel = new Error("captured");
    providerRegistry.register("wire-capture", {
      stream: (options) => {
        captured = options;
        throw sentinel;
      },
    });

    try {
      expect(() =>
        stream({
          provider: "wire-capture" as StreamOptions["provider"],
          model: "test",
          messages: [
            { role: "user", content: "read a file \uD83D" },
            {
              role: "tool",
              content: [{ type: "tool_result", toolCallId: "1", content: "\uDE00 output" }],
            },
          ],
        }),
      ).toThrow(sentinel);
      // Assert on the raw strings: well-formed `JSON.stringify` escapes a lone
      // surrogate to ASCII `\ud83d`, so checking the serialized body would pass
      // even if the scrub never ran.
      const user = captured?.messages[0];
      const tool = captured?.messages[1] as { content: { content: string }[] } | undefined;
      expect(user?.content).toBe("read a file \uFFFD");
      expect(tool?.content[0]?.content).toBe("\uFFFD output");
    } finally {
      providerRegistry.unregister("wire-capture");
    }
  });
});
