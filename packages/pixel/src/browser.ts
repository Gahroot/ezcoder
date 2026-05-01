import { installBrowserAdapter, type BrowserAdapter } from "./adapters/browser.js";
import { HttpSink } from "./core/sinks/http.js";
import type { Sink } from "./core/types.js";

export const DEFAULT_INGEST_URL = "https://ez-pixel-server.buzzbeamaustralia.workers.dev";

export interface BrowserPixelOptions {
  projectKey: string;
  /** Backend ingest URL. Defaults to the public ez-pixel server. */
  ingestUrl?: string;
  /** Override the runtime label. Default: `browser-<UA short>`. */
  runtime?: string;
  /** Inject a custom sink — overrides ingestUrl. */
  sink?: Sink;
  captureConsoleErrors?: boolean;
  captureConsoleWarnings?: boolean;
  captureUnhandledRejections?: boolean;
  captureUncaughtExceptions?: boolean;
  /** Capture failed outgoing fetch/XHR requests (5xx + network failures). Default: true. */
  captureNetworkErrors?: boolean;
  /** Substrings of URLs to skip when capturing network errors. The ingest URL is auto-ignored. */
  ignoreNetworkUrls?: string[];
}

let active: BrowserAdapter | null = null;

export function initPixel(options: BrowserPixelOptions): BrowserAdapter {
  if (active) {
    throw new Error("ez-pixel is already initialized; call closePixel() first");
  }
  const ingestFull = buildIngestUrl(options.ingestUrl);
  const sink: Sink = options.sink ?? new HttpSink(ingestFull);
  // Auto-ignore the ingest endpoint itself — otherwise reporting a 500
  // from somewhere else would observe our own POST /ingest and recurse.
  const ingestOrigin = safeOrigin(ingestFull);
  const ignoreNetworkUrls = [
    ...(options.ignoreNetworkUrls ?? []),
    ...(ingestOrigin ? [ingestOrigin] : []),
  ];
  active = installBrowserAdapter({
    projectKey: options.projectKey,
    runtime: options.runtime ?? defaultRuntime(),
    sink,
    captureConsoleErrors: options.captureConsoleErrors ?? false,
    captureConsoleWarnings: options.captureConsoleWarnings ?? false,
    captureUnhandledRejections: options.captureUnhandledRejections ?? true,
    captureUncaughtExceptions: options.captureUncaughtExceptions ?? true,
    captureNetworkErrors: options.captureNetworkErrors ?? true,
    ignoreNetworkUrls,
  });
  return active;
}

export function reportPixel(input: {
  message: string;
  error?: unknown;
  level?: "error" | "warning" | "fatal";
}): void {
  if (!active) return;
  active.report(input);
}

export async function flushPixel(): Promise<void> {
  if (!active) return;
  await active.flush();
}

export async function closePixel(): Promise<void> {
  if (!active) return;
  await active.close();
  active = null;
}

function buildIngestUrl(base?: string): string {
  const url = (base ?? DEFAULT_INGEST_URL).replace(/\/+$/, "");
  return `${url}/ingest`;
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function defaultRuntime(): string {
  if (typeof navigator === "undefined") return "browser-unknown";
  const ua = navigator.userAgent;
  if (/Chrome\/(\d+)/.test(ua)) return `chrome-${RegExp.$1}`;
  if (/Firefox\/(\d+)/.test(ua)) return `firefox-${RegExp.$1}`;
  if (/Version\/(\d+).*Safari/.test(ua)) return `safari-${RegExp.$1}`;
  if (/Edg\/(\d+)/.test(ua)) return `edge-${RegExp.$1}`;
  return "browser";
}

export type { Level, ReportInput, StackFrame, WireEvent } from "./core/types.js";
