import type { JsonObject, VoiceBridgeCommand, VoiceBridgeEvent, VoiceTool } from "../types.js";

export interface EzBossPromptTarget {
  enqueueUserMessage(text: string): Promise<void> | void;
}

export interface EzBossBridge {
  send(command: VoiceBridgeCommand, signal?: AbortSignal): Promise<VoiceBridgeEvent>;
  toTool(): VoiceTool;
}

export function createEzBossBridge(target: EzBossPromptTarget): EzBossBridge {
  return {
    async send(command, signal): Promise<VoiceBridgeEvent> {
      throwIfAborted(signal);
      if (command.type !== "prompt") {
        return {
          type: "error",
          error: `Unsupported EzBoss bridge command: ${command.type}`,
        };
      }
      await target.enqueueUserMessage(command.text);
      return { type: "task_dispatch", text: command.text };
    },
    toTool(): VoiceTool {
      return createSendToEzBossTool(this);
    },
  };
}

export function createRelayEzBossTool(
  send: (command: VoiceBridgeCommand) => Promise<JsonObject>,
): VoiceTool {
  return {
    name: "send_to_ezboss",
    description: "Send a prompt to a EZ Boss orchestrator relay.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Prompt text to send to EZ Boss." },
      },
      required: ["text"],
    },
    async execute(args) {
      const text = typeof args.text === "string" ? args.text : "";
      if (!text) {
        return { error: "text is required" };
      }
      return send({ type: "prompt", text });
    },
  };
}

function createSendToEzBossTool(bridge: EzBossBridge): VoiceTool {
  return {
    name: "send_to_ezboss",
    description: "Send a prompt to an in-process EZ Boss orchestrator.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Prompt text to send to EZ Boss." },
      },
      required: ["text"],
    },
    async execute(args, context) {
      const text = typeof args.text === "string" ? args.text : "";
      if (!text) {
        return { error: "text is required" };
      }
      const event = await bridge.send({ type: "prompt", text }, context.signal);
      return event;
    },
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("EzBoss bridge command aborted");
  }
}
