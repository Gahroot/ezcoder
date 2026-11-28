// What to run on the other machine to add it (Add a machine, D2). One place,
// so the steps follow the CLI's quick start (packages/cli/docs/fleet-nodes.md).

export type SetupPlatform = "linux" | "wsl2" | "macos";

export interface SetupStep {
  /** What the step does, in plain words. */
  label: string;
  command: string;
}

export interface PlatformSetup {
  id: SetupPlatform;
  label: string;
  /** What the machine needs before the steps. */
  needs: string;
  steps: readonly SetupStep[];
}

const INSTALL = "npm i -g @prestyj/cli";
const COMMON: readonly SetupStep[] = [
  { label: "Set it up as a machine for EZ Coder", command: "ezcoder node init" },
  { label: "Keep it running, also after a restart", command: "ezcoder node install" },
  { label: "Get a code to type in here", command: "ezcoder node pair --code" },
];

export const PLATFORM_SETUP: readonly PlatformSetup[] = [
  {
    id: "linux",
    label: "Linux",
    needs:
      "Node.js 22 or newer, git, and Tailscale signed in to the same account as this computer.",
    steps: [{ label: "Install EZ Coder", command: INSTALL }, ...COMMON],
  },
  {
    id: "wsl2",
    label: "Windows (WSL2)",
    needs:
      "Windows runs it inside Ubuntu on WSL2. In PowerShell run `wsl --install -d Ubuntu`, open Ubuntu, then install Node.js 22 or newer, git and Tailscale there.",
    steps: [{ label: "Install EZ Coder (in Ubuntu)", command: INSTALL }, ...COMMON],
  },
  {
    id: "macos",
    label: "macOS",
    needs: "Node.js 22 or newer, git, and the Tailscale app signed in to the same account.",
    steps: [{ label: "Install EZ Coder", command: INSTALL }, ...COMMON],
  },
];

/** Every step as one line to paste in a terminal. */
export function oneLiner(setup: PlatformSetup): string {
  return setup.steps.map((s) => s.command).join(" && ");
}
