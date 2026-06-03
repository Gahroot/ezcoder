import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Message, Provider } from "@prestyj/ai";
import type { AgentTool } from "@prestyj/agent";
import { buildSystemPrompt } from "../../system-prompt.js";
import type { LanguageId } from "../../core/language-detector.js";
import type { Skill } from "../../core/skills.js";
import type { GoalMode } from "../../core/runtime-mode.js";

/** Options accepted by {@link useModeState.rebuildSystemPrompt}. */
export interface RebuildSystemPromptOptions {
  cwd?: string;
  approvedPlanPath?: string;
  clearApprovedPlan?: boolean;
  activeLanguages?: Set<LanguageId>;
  tools?: AgentTool[];
  planMode?: boolean;
}

/** Minimal session-store surface the mode state mirrors into for remount survival. */
interface ModeSessionStore {
  planMode?: boolean;
  goalMode?: GoalMode;
}

interface UseModeStateOptions {
  initialPlanMode: boolean;
  initialGoalMode?: GoalMode;
  skills: Skill[] | undefined;
  planModeRef?: { current: boolean };
  goalModeRef?: { current: GoalMode };
  sessionStore?: ModeSessionStore;
  // External refs the system prompt is rebuilt from (owned by App).
  cwdRef: MutableRefObject<string>;
  currentToolsRef: MutableRefObject<AgentTool[]>;
  // Active provider, consulted so the prompt identity tracks the current model.
  providerRef: MutableRefObject<Provider>;
  approvedPlanPathRef: MutableRefObject<string | undefined>;
  injectedLanguagesRef: MutableRefObject<Set<LanguageId>>;
  messagesRef: MutableRefObject<Message[]>;
}

export interface ModeState {
  planMode: boolean;
  goalMode: GoalMode;
  planModeStateRef: MutableRefObject<boolean>;
  goalModeStateRef: MutableRefObject<GoalMode>;
  rebuildSystemPrompt: (options?: RebuildSystemPromptOptions) => Promise<string>;
  replaceSystemPrompt: (options?: RebuildSystemPromptOptions) => Promise<string>;
  setPlanModeAndPrompt: (nextMode: boolean) => Promise<void>;
  setGoalModeAndPrompt: (nextMode: GoalMode) => Promise<void>;
}

/**
 * Owns the `planMode` runtime state and the system-prompt rebuild cluster
 * (`rebuildSystemPrompt`, `replaceSystemPrompt`, `setPlanModeAndPrompt`).
 * Extracted from `App.tsx` as a self-contained controller.
 */
export function useModeState({
  initialPlanMode,
  initialGoalMode = "off",
  skills,
  planModeRef,
  goalModeRef,
  sessionStore,
  cwdRef,
  currentToolsRef,
  providerRef,
  approvedPlanPathRef,
  injectedLanguagesRef,
  messagesRef,
}: UseModeStateOptions): ModeState {
  const [planMode, setPlanMode] = useState(initialPlanMode);
  const [goalMode, setGoalMode] = useState<GoalMode>(initialGoalMode);
  const planModeStateRef = useRef(planMode);
  const goalModeStateRef = useRef<GoalMode>(goalMode);

  useEffect(() => {
    planModeStateRef.current = planMode;
    if (planModeRef) planModeRef.current = planMode;
  }, [planMode, planModeRef]);

  useEffect(() => {
    goalModeStateRef.current = goalMode;
    if (goalModeRef) goalModeRef.current = goalMode;
  }, [goalMode, goalModeRef]);

  const rebuildSystemPrompt = useCallback(
    async (options?: RebuildSystemPromptOptions): Promise<string> => {
      const approvedPlanPath = options?.clearApprovedPlan
        ? undefined
        : (options?.approvedPlanPath ?? approvedPlanPathRef.current);
      return buildSystemPrompt(
        options?.cwd ?? cwdRef.current,
        skills,
        options?.planMode ?? planModeStateRef.current,
        approvedPlanPath,
        (options?.tools ?? currentToolsRef.current).map((tool) => tool.name),
        options?.activeLanguages ?? injectedLanguagesRef.current,
        providerRef.current,
        goalModeStateRef.current,
      );
    },
    [skills, approvedPlanPathRef, cwdRef, currentToolsRef, providerRef, injectedLanguagesRef],
  );

  const replaceSystemPrompt = useCallback(
    async (options?: RebuildSystemPromptOptions): Promise<string> => {
      const newPrompt = await rebuildSystemPrompt(options);
      if (messagesRef.current[0]?.role === "system") {
        messagesRef.current[0] = { role: "system" as const, content: newPrompt };
      }
      return newPrompt;
    },
    [rebuildSystemPrompt, messagesRef],
  );

  const setPlanModeAndPrompt = useCallback(
    async (nextMode: boolean): Promise<void> => {
      planModeStateRef.current = nextMode;
      if (planModeRef) planModeRef.current = nextMode;
      if (sessionStore) sessionStore.planMode = nextMode;
      setPlanMode(nextMode);
      await replaceSystemPrompt({ planMode: nextMode });
    },
    [planModeRef, sessionStore, replaceSystemPrompt],
  );

  const setGoalModeAndPrompt = useCallback(
    async (nextMode: GoalMode): Promise<void> => {
      goalModeStateRef.current = nextMode;
      if (goalModeRef) goalModeRef.current = nextMode;
      if (sessionStore) sessionStore.goalMode = nextMode;
      setGoalMode(nextMode);
      await replaceSystemPrompt();
    },
    [goalModeRef, sessionStore, replaceSystemPrompt],
  );

  return {
    planMode,
    goalMode,
    planModeStateRef,
    goalModeStateRef,
    rebuildSystemPrompt,
    replaceSystemPrompt,
    setPlanModeAndPrompt,
    setGoalModeAndPrompt,
  };
}
