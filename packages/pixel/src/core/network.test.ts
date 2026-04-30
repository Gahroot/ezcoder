import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installFetchInstrumentation,
  installXhrInstrumentation,
  networkObservationToError,
  shouldReportNetwork,
  type NetworkObservation,
} from "./network.js";

describe("installFetchInstrumentation", () => {
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch as typeof fetch;
  });

  it("captures status on a 2xx response without altering the result", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 })) as never;
    const seen: NetworkObservation[] = [];
    const unhook = installFetchInstrumentation({ onEvent: (o) => seen.push(o) });

    const res = await fetch("https://api.example.com/widgets", { method: "POST" });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://api.example.com/widgets");
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.status).toBe(200);
    expect(seen[0]?.error).toBeUndefined();

    unhook();
  });

  it("captures status on a 5xx and re-resolves the response untouched", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("boom", { status: 503 })) as never;
    const seen: NetworkObservation[] = [];
    const unhook = installFetchInstrumentation({ onEvent: (o) => seen.push(o) });

    const res = await fetch("https://api.example.com/health");
    expect(res.status).toBe(503);
    expect(seen[0]?.status).toBe(503);

    unhook();
  });

  it("captures thrown errors with status=0 and re-throws", async () => {
    const boom = new TypeError("Failed to fetch");
    globalThis.fetch = vi.fn().mockRejectedValue(boom) as never;
    const seen: NetworkObservation[] = [];
    const unhook = installFetchInstrumentation({ onEvent: (o) => seen.push(o) });

    await expect(fetch("https://down.example.com")).rejects.toThrow("Failed to fetch");
    expect(seen[0]?.status).toBe(0);
    expect(seen[0]?.error).toBe(boom);

    unhook();
  });

  it("respects ignoreUrls and does not invoke onEvent for matched URLs", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("ok")) as never;
    const seen: NetworkObservation[] = [];
    const unhook = installFetchInstrumentation({
      onEvent: (o) => seen.push(o),
      ignoreUrls: ["ingest.example"],
    });

    await fetch("https://ingest.example.com/ingest");
    await fetch("https://other.example.com/api");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://other.example.com/api");

    unhook();
  });

  it("unhook restores the original fetch", () => {
    const original = vi.fn().mockResolvedValue(new Response("ok"));
    globalThis.fetch = original as never;
    const unhook = installFetchInstrumentation({ onEvent: () => {} });
    expect(globalThis.fetch).not.toBe(original);
    unhook();
    expect(globalThis.fetch).toBe(original);
  });
});

describe("installXhrInstrumentation", () => {
  it("is a no-op when XMLHttpRequest is missing", () => {
    const stash = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
    delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
    const unhook = installXhrInstrumentation({ onEvent: () => {} });
    expect(typeof unhook).toBe("function");
    unhook();
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = stash;
  });
});

describe("shouldReportNetwork", () => {
  it("reports thrown errors", () => {
    expect(
      shouldReportNetwork({
        url: "x",
        method: "GET",
        status: 0,
        duration_ms: 1,
        error: new Error("boom"),
      }),
    ).toBe(true);
  });
  it("reports 5xx", () => {
    expect(shouldReportNetwork({ url: "x", method: "GET", status: 500, duration_ms: 1 })).toBe(
      true,
    );
    expect(shouldReportNetwork({ url: "x", method: "GET", status: 599, duration_ms: 1 })).toBe(
      true,
    );
  });
  it("ignores 2xx and 4xx by default", () => {
    expect(shouldReportNetwork({ url: "x", method: "GET", status: 200, duration_ms: 1 })).toBe(
      false,
    );
    expect(shouldReportNetwork({ url: "x", method: "GET", status: 404, duration_ms: 1 })).toBe(
      false,
    );
    expect(shouldReportNetwork({ url: "x", method: "GET", status: 499, duration_ms: 1 })).toBe(
      false,
    );
  });
});

describe("networkObservationToError", () => {
  it("uses the underlying error for thrown failures", () => {
    const inner = new TypeError("Failed to fetch");
    const err = networkObservationToError({
      url: "https://x",
      method: "GET",
      status: 0,
      duration_ms: 12,
      error: inner,
    });
    expect(err.name).toBe("NetworkError");
    expect(err.message).toContain("Failed to fetch");
    expect(err.message).toContain("GET https://x");
    expect(err.stack).toBe(inner.stack);
  });
  it("describes the status for 5xx", () => {
    const err = networkObservationToError({
      url: "https://x",
      method: "POST",
      status: 503,
      duration_ms: 9,
    });
    expect(err.name).toBe("NetworkError");
    expect(err.message).toContain("HTTP 503");
    expect(err.message).toContain("POST https://x");
  });
});
