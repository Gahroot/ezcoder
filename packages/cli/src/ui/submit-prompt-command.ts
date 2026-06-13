import type React from "react";
import type { ImageAttachment } from "../utils/image.js";
import { getModel } from "../core/model-registry.js";
import { PROMPT_COMMANDS, getPromptCommand } from "../core/prompt-commands.js";
import type { CustomCommand } from "../core/custom-commands.js";
import { log } from "../core/logger.js";
import { buildUserContentWithAttachments, routePromptCommandInput } from "./prompt-routing.js";
import type { CompletedItem, UserItem } from "./app-items.js";
import type { UserContent } from "./hooks/useAgentLoop.js";
import { toErrorItem } from "./error-item.js";
import type { Message } from "@prestyj/ai";
import type { GoalMode } from "../core/runtime-mode.js";

const GOAL_PLANNER_OUTPUT_MAX_CHARS = 2400;

function messageTextContent(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function collectAssistantTextSince(
  messages: readonly Message[],
  startIndex: number,
  maxChars = GOAL_PLANNER_OUTPUT_MAX_CHARS,
): string {
  const text = messages
    .slice(startIndex)
    .filter((message) => message.role === "assistant")
    .map(messageTextContent)
    .join("\n")
    .trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n[planner output truncated]`;
}

export function buildGoalSetupPromptFromPlanner({
  originalGoalPrompt,
  plannerOutput,
}: {
  originalGoalPrompt: string;
  plannerOutput: string;
}): string {
  const compactPlannerOutput = plannerOutput.trim() || "GOAL_PLAN\nresearch=none\nEND_GOAL_PLAN";
  return (
    `${originalGoalPrompt.trim()}\n\n` +
    `## Goal Planner Output\n\n${compactPlannerOutput}\n\n` +
    `Use the original objective plus this planner output to create durable Goal setup only. ` +
    `Do not redo planner research unless the planner output is unusable.`
  );
}

export function isGoalPromptCommandName(cmdName: string): boolean {
  return getPromptCommand(cmdName)?.name === "goal";
}

export async function runGoalPromptSetupSequence({
  userContent,
  fullPrompt,
  messagesRef,
  setGoalModeAndPrompt,
  runAgent,
  onStage,
}: {
  userContent: UserContent;
  fullPrompt: string;
  messagesRef: { current: Message[] };
  setGoalModeAndPrompt: (nextMode: GoalMode) => Promise<void>;
  runAgent: (content: UserContent) => Promise<void>;
  onStage?: (text: string) => void;
}): Promise<void> {
  onStage?.("GOAL PLANNER STARTED");
  await setGoalModeAndPrompt("planner");
  const plannerStartIndex = messagesRef.current.length;
  await runAgent(userContent);
  const plannerOutput = collectAssistantTextSince(messagesRef.current, plannerStartIndex);
  const setupPrompt = buildGoalSetupPromptFromPlanner({
    originalGoalPrompt: fullPrompt,
    plannerOutput,
  });
  onStage?.("GOAL PLAN CREATED -> PASSING TO SETUP AGENT");
  await setGoalModeAndPrompt("setup");
  onStage?.("GOAL SETUP AGENT STARTED");
  await runAgent(setupPrompt);
  onStage?.("GOAL SETUP COMPLETE -> OPENING GOAL PANE");
}

interface PromptCommandSubmitOptions {
  trimmed: string;
  inputImages: ImageAttachment[];
  currentModel: string;
  customCommands: CustomCommand[];
  setLastUserMessage: (message: string) => void;
  setDoneStatus: (status: { verb: string; durationMs: number; toolsUsed: string[] } | null) => void;
  finalizeSubmittedUserItem: (item: UserItem) => void;
  runAgent: (content: UserContent) => Promise<void>;
  setLiveItems: React.Dispatch<React.SetStateAction<CompletedItem[]>>;
  getId: () => string;
  reloadCustomCommands: () => void;
  messagesRef?: { current: Message[] };
  setGoalModeAndPrompt?: (nextMode: GoalMode) => Promise<void>;
  onGoalStage?: (text: string) => void;
  onGoalSetupComplete?: () => void | Promise<void>;
}

export async function submitPromptCommand({
  trimmed,
  inputImages,
  currentModel,
  customCommands,
  setLastUserMessage,
  setDoneStatus,
  finalizeSubmittedUserItem,
  runAgent,
  setLiveItems,
  getId,
  reloadCustomCommands,
  messagesRef,
  setGoalModeAndPrompt,
  onGoalStage,
  onGoalSetupComplete,
}: PromptCommandSubmitOptions): Promise<boolean> {
  const promptCommandRoute = routePromptCommandInput(trimmed, PROMPT_COMMANDS, customCommands);
  if (!promptCommandRoute) return false;

  const { cmdName, cmdArgs, fullPrompt } = promptCommandRoute;
  log("INFO", "command", `Prompt command: /${cmdName}${cmdArgs ? ` (args: ${cmdArgs})` : ""}`);

  const imageCount = inputImages.filter((img) => img.kind === "image").length;
  const videoCount = inputImages.filter((img) => img.kind === "video").length;

  const modelInfo = getModel(currentModel);
  const modelSupportsImages = modelInfo?.supportsImages ?? true;
  const modelSupportsVideo = modelInfo?.supportsVideo ?? false;
  const userContent = buildUserContentWithAttachments(
    fullPrompt,
    inputImages,
    modelSupportsImages,
    modelSupportsVideo,
  );

  const userItem: UserItem = {
    kind: "user",
    text: trimmed,
    imageCount: imageCount > 0 ? imageCount : undefined,
    videoCount: videoCount > 0 ? videoCount : undefined,
    id: getId(),
  };
  setLastUserMessage(trimmed);
  setDoneStatus(null);
  finalizeSubmittedUserItem(userItem);

  const isGoalSetupCommand = isGoalPromptCommandName(cmdName);

  try {
    if (isGoalSetupCommand && messagesRef && setGoalModeAndPrompt) {
      await runGoalPromptSetupSequence({
        userContent,
        fullPrompt,
        messagesRef,
        setGoalModeAndPrompt,
        runAgent,
        onStage: onGoalStage,
      });
      await onGoalSetupComplete?.();
    } else {
      await runAgent(userContent);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("ERROR", "error", msg);
    const isAbort = msg.includes("aborted") || msg.includes("abort");
    setLiveItems((prev) => [
      ...prev,
      isAbort
        ? { kind: "stopped", text: "Request was stopped.", id: getId() }
        : toErrorItem(err, getId()),
    ]);
  } finally {
    if (isGoalSetupCommand && setGoalModeAndPrompt) {
      await setGoalModeAndPrompt("off");
    }
  }

  reloadCustomCommands();
  return true;
}
