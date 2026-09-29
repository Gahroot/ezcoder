/** One-click prompts fill the composer; users can add their inputs before sending. */
export const MOTION_STARTERS = [
  {
    label: "Make a split-text opener",
    prompt:
      "Use the mixkit-split-text-617 skill to make an opener. Preserve its source choreography, timing, reveals and outline echoes; change only the permitted text, font and media inputs. Check and render the result, and report any unverified translation. My text, brand and assets: ",
  },
  {
    label: "Edit my Motion project",
    prompt:
      "Edit my existing Motion project. Read its current recipe and input bindings, preserve the choreography and reuse its assets. Change only what I request, then check the affected result and export to a new versioned filename. Project and changes: ",
  },
] as const;
