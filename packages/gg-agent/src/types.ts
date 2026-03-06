import type { z } from "zod";
import type {
  Tool,
  AssistantMessage,
  Message,
  ServerToolDefinition,
  StopReason,
  Usage,
  StreamOptions,
} from "@kenkaiiii/gg-ai";

// ── Tool Results ────────────────────────────────────────────

export interface StructuredToolResult {
  content: string;
  details?: unknown;
}

export type ToolExecuteResult = string | StructuredToolResult;

// ── Tool Context ────────────────────────────────────────────

export interface ToolContext {
  signal: AbortSignal;
  toolCallId: string;
  onUpdate?: (update: unknown) => void;
}

// ── Agent Tool ──────────────────────────────────────────────

export interface AgentTool<T extends z.ZodType = z.ZodType> extends Tool {
  parameters: T;
  execute: (
    args: z.infer<T>,
    context: ToolContext,
  ) => ToolExecuteResult | Promise<ToolExecuteResult>;
}

// ── Agent Events ────────────────────────────────────────────

export interface AgentTextDeltaEvent {
  type: "text_delta";
  text: string;
}

export interface AgentThinkingDeltaEvent {
  type: "thinking_delta";
  text: string;
}

export interface AgentToolCallStartEvent {
  type: "tool_call_start";
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface AgentToolCallUpdateEvent {
  type: "tool_call_update";
  toolCallId: string;
  update: unknown;
}

export interface AgentToolCallEndEvent {
  type: "tool_call_end";
  toolCallId: string;
  result: string;
  details?: unknown;
  isError: boolean;
  durationMs: number;
}

export interface AgentTurnEndEvent {
  type: "turn_end";
  turn: number;
  stopReason: StopReason;
  usage: Usage;
}

export interface AgentDoneEvent {
  type: "agent_done";
  totalTurns: number;
  totalUsage: Usage;
}

export interface AgentErrorEvent {
  type: "error";
  error: Error;
}

export interface AgentServerToolCallEvent {
  type: "server_tool_call";
  id: string;
  name: string;
  input: unknown;
}

export interface AgentServerToolResultEvent {
  type: "server_tool_result";
  toolUseId: string;
  resultType: string;
  data: unknown;
}

export type AgentEvent =
  | AgentTextDeltaEvent
  | AgentThinkingDeltaEvent
  | AgentToolCallStartEvent
  | AgentToolCallUpdateEvent
  | AgentToolCallEndEvent
  | AgentServerToolCallEvent
  | AgentServerToolResultEvent
  | AgentTurnEndEvent
  | AgentDoneEvent
  | AgentErrorEvent;

// ── Agent Options ───────────────────────────────────────────

export interface AgentOptions {
  provider: StreamOptions["provider"];
  model: string;
  system?: string;
  tools?: AgentTool[];
  serverTools?: ServerToolDefinition[];
  maxTurns?: number;
  maxTokens?: number;
  temperature?: number;
  thinking?: StreamOptions["thinking"];
  apiKey?: string;
  baseUrl?: string;
  signal?: AbortSignal;
  accountId?: string;
  cacheRetention?: StreamOptions["cacheRetention"];
  /**
   * Called before each LLM call. Allows the caller to inspect and transform
   * the messages array (e.g. compaction, truncation). Return the same array
   * for no-op, or a new array to replace the conversation context.
   */
  transformContext?: (messages: Message[]) => Message[] | Promise<Message[]>;
}

// ── Agent Result ────────────────────────────────────────────

export interface AgentResult {
  message: AssistantMessage;
  totalTurns: number;
  totalUsage: Usage;
}
