import { installNodeAdapter, type NodeAdapter } from "./adapters/node.js";
import { NodeHttpSink } from "./core/sinks/node-http.js";
import { LocalSqliteSink } from "./core/sinks/local-sqlite.js";
import type { PixelOptions, ReportInput, Sink, SinkConfig } from "./core/types.js";

let active: NodeAdapter | null = null;

export function initPixel(options: PixelOptions): NodeAdapter {
  if (active) {
    throw new Error("ez-pixel is already initialized; call closePixel() first");
  }
  const sink = buildSink(options.sink);
  // Auto-ignore the ingest URL — otherwise our own POST /ingest would be
  // observed by undici diagnostics_channel and trigger recursion.
  const autoIgnore = options.sink.kind === "http" ? [safeOrigin(options.sink.ingestUrl)] : [];
  const ignoreNetworkUrls = [...(options.ignoreNetworkUrls ?? []), ...autoIgnore].filter(
    (s): s is string => typeof s === "string",
  );
  active = installNodeAdapter({
    projectKey: options.projectKey,
    runtime: options.runtime ?? defaultRuntime(),
    sink,
    captureConsoleErrors: options.captureConsoleErrors ?? true,
    captureConsoleWarnings: options.captureConsoleWarnings ?? false,
    captureUnhandledRejections: options.captureUnhandledRejections ?? true,
    captureUncaughtExceptions: options.captureUncaughtExceptions ?? true,
    captureNetworkErrors: options.captureNetworkErrors ?? true,
    ignoreNetworkUrls,
  });
  return active;
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function reportPixel(input: ReportInput): void {
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

function buildSink(config: SinkConfig): Sink {
  switch (config.kind) {
    case "http":
      return new NodeHttpSink(config.ingestUrl, config.fetchFn);
    case "local":
      return new LocalSqliteSink(config.path);
    case "custom":
      return config.sink;
  }
}

function defaultRuntime(): string {
  const v = process.versions.node;
  return `node-${v}`;
}

export type {
  Level,
  PixelOptions,
  ReportInput,
  Sink,
  SinkConfig,
  StackFrame,
  CodeContext,
  WireEvent,
} from "./core/types.js";

export { install, DEFAULT_INGEST_URL } from "./install.js";
export type { InstallOptions, InstallResult, PackageManager } from "./install.js";
