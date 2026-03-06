import OpenAI from "openai";
import type { ContentPart, StreamOptions, StreamResponse, ToolCall } from "../types.js";
import { ProviderError } from "../errors.js";
import { StreamResult } from "../utils/event-stream.js";
import {
  normalizeOpenAIStopReason,
  toOpenAIMessages,
  toOpenAIReasoningEffort,
  toOpenAIToolChoice,
  toOpenAITools,
} from "./transform.js";

export function streamOpenAI(options: StreamOptions): StreamResult {
  const result = new StreamResult();
  runStream(options, result).catch((err) => result.abort(toError(err)));
  return result;
}

async function runStream(options: StreamOptions, result: StreamResult): Promise<void> {
  const client = new OpenAI({
    apiKey: options.apiKey,
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
  });

  const messages = toOpenAIMessages(options.messages);

  const params: OpenAI.ChatCompletionCreateParams = {
    model: options.model,
    messages,
    stream: true,
    ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    ...(options.temperature != null && !options.thinking
      ? { temperature: options.temperature }
      : {}),
    ...(options.topP != null ? { top_p: options.topP } : {}),
    ...(options.stop ? { stop: options.stop } : {}),
    ...(options.thinking ? { reasoning_effort: toOpenAIReasoningEffort(options.thinking) } : {}),
    ...(options.tools?.length ? { tools: toOpenAITools(options.tools) } : {}),
    ...(options.toolChoice && options.tools?.length
      ? { tool_choice: toOpenAIToolChoice(options.toolChoice) }
      : {}),
    stream_options: { include_usage: true },
  };

  const stream = await client.chat.completions.create(params, {
    signal: options.signal ?? undefined,
  });

  const contentParts: ContentPart[] = [];
  const toolCallAccum = new Map<number, { id: string; name: string; argsJson: string }>();
  let textAccum = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let finishReason: string | null = null;

  for await (const chunk of stream as AsyncIterable<OpenAI.ChatCompletionChunk>) {
    const choice = chunk.choices?.[0];

    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens;
      outputTokens = chunk.usage.completion_tokens;
      const details = chunk.usage.prompt_tokens_details;
      if (details?.cached_tokens) {
        cacheRead = details.cached_tokens;
      }
    }

    if (!choice) continue;

    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
    }

    const delta = choice.delta;

    // Text delta
    if (delta.content) {
      textAccum += delta.content;
      result.push({ type: "text_delta", text: delta.content });
    }

    // Tool call deltas
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        let accum = toolCallAccum.get(tc.index);
        if (!accum) {
          accum = {
            id: tc.id ?? "",
            name: tc.function?.name ?? "",
            argsJson: "",
          };
          toolCallAccum.set(tc.index, accum);
        }
        if (tc.id) accum.id = tc.id;
        if (tc.function?.name) accum.name = tc.function.name;
        if (tc.function?.arguments) {
          accum.argsJson += tc.function.arguments;
          result.push({
            type: "toolcall_delta",
            id: accum.id,
            name: accum.name,
            argsJson: tc.function.arguments,
          });
        }
      }
    }
  }

  // Finalize text content
  if (textAccum) {
    contentParts.push({ type: "text", text: textAccum });
  }

  // Finalize tool calls
  for (const [, tc] of toolCallAccum) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.argsJson) as Record<string, unknown>;
    } catch {
      // malformed JSON — keep empty
    }
    const toolCall: ToolCall = {
      type: "tool_call",
      id: tc.id,
      name: tc.name,
      args,
    };
    contentParts.push(toolCall);
    result.push({
      type: "toolcall_done",
      id: tc.id,
      name: tc.name,
      args,
    });
  }

  const stopReason = normalizeOpenAIStopReason(finishReason);

  const response: StreamResponse = {
    message: {
      role: "assistant",
      content: contentParts.length > 0 ? contentParts : textAccum || "",
    },
    stopReason,
    usage: { inputTokens, outputTokens, ...(cacheRead > 0 && { cacheRead }) },
  };

  result.push({ type: "done", stopReason });
  result.complete(response);
}

function toError(err: unknown): ProviderError {
  if (err instanceof OpenAI.APIError) {
    return new ProviderError("openai", err.message, {
      statusCode: err.status,
      cause: err,
    });
  }
  if (err instanceof Error) {
    return new ProviderError("openai", err.message, { cause: err });
  }
  return new ProviderError("openai", String(err));
}
