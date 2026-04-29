function rand(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

export const projectId = (): string => rand("proj");
export const errorId = (): string => rand("err");
export const projectKey = (): string => rand("pk_live");
