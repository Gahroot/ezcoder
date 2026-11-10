import { describe, expect, it } from "vitest";
import { chatWorkspacePath, motionWorkspacePath } from "./motion-workspace";

describe("motionWorkspacePath", () => {
  it.each([
    ["/Users/me/Projects", "/Users/me/Projects/EZ Motion"],
    ["/Users/me/Projects/", "/Users/me/Projects/EZ Motion"],
    ["C:\\Users\\me\\Projects", "C:\\Users\\me\\Projects\\EZ Motion"],
    ["C:\\Users\\me\\Projects\\", "C:\\Users\\me\\Projects\\EZ Motion"],
    ["C:/Users/me/Projects", "C:/Users/me/Projects/EZ Motion"],
  ])("places the Motion folder inside %s", (root, expected) => {
    expect(motionWorkspacePath(root)).toBe(expected);
  });
});

describe("chatWorkspacePath", () => {
  it.each([
    ["/Users/me/Projects", "/Users/me/Projects/EZ Chat"],
    ["/Users/me/Projects/", "/Users/me/Projects/EZ Chat"],
    ["C:\\Users\\me\\Projects", "C:\\Users\\me\\Projects\\EZ Chat"],
  ])("places the Chat folder inside %s", (root, expected) => {
    expect(chatWorkspacePath(root)).toBe(expected);
  });
});
