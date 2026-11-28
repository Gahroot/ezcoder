/**
 * Which computer an agent or Goal worker runs on, in words (D4). The sidecar's
 * sub-agent snapshot carries `machine` for remote agents: a paired machine's
 * name, or "auto"/"cloud" before one is picked. Absent means this computer.
 */
export function machineLabel(machine: string | undefined): string {
  const name = machine?.trim();
  if (!name || name === "local") return "this computer";
  if (name === "auto") return "another machine";
  if (name === "cloud") return "the cloud";
  return name;
}

/** True when the work runs somewhere other than this computer. */
export function isRemoteMachine(machine: string | undefined): boolean {
  return machineLabel(machine) !== "this computer";
}
