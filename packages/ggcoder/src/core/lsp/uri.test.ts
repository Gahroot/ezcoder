import { describe, expect, it } from "vitest";

import { normalizeUri } from "./client.js";

describe("normalizeUri", () => {
  // Diagnostics are cached by URI string. We build ours from the edited path
  // (uppercase drive), servers emit VS Code's lowercase form — so on Windows
  // every cache lookup missed and inline diagnostics silently never appeared.
  it("lowercases the Windows drive letter so both sides agree", () => {
    expect(normalizeUri("file:///C:/repo/src/a.ts")).toBe("file:///c:/repo/src/a.ts");
    expect(normalizeUri("file:///c:/repo/src/a.ts")).toBe("file:///c:/repo/src/a.ts");
  });

  it("handles a percent-encoded drive colon", () => {
    expect(normalizeUri("file:///C%3A/repo/a.ts")).toBe("file:///c:/repo/a.ts");
  });

  it("leaves POSIX and non-file URIs untouched", () => {
    expect(normalizeUri("file:///Users/dev/a.ts")).toBe("file:///Users/dev/a.ts");
    expect(normalizeUri("untitled:Untitled-1")).toBe("untitled:Untitled-1");
  });
});
