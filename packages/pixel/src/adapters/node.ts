import { randomUUID } from "node:crypto";
import * as diagnosticsChannel from "node:diagnostics_channel";
import { parseStack } from "../core/stack.js";
import { fingerprint } from "../core/fingerprint.js";
import { captureCodeContext } from "../code-context.js";
import { EventQueue } from "../core/queue.js";
import {
  networkObservationToError,
  shouldReportNetwork,
  type NetworkObservation,
} from "../core/network.js";
import type { Level, ReportInput, Sink, WireEvent } from "../core/types.js";

export interface NodeAdapterOptions {
  projectKey: string;
  runtime: string;
  sink: Sink;
  captureConsoleErrors: boolean;
  captureConsoleWarnings: boolean;
  captureUnhandledRejections: boolean;
  captureUncaughtExceptions: boolean;
  captureNetworkErrors: boolean;
  /** Substrings of URLs to skip. The ingest URL is auto-ignored. */
  ignoreNetworkUrls?: string[];
}

export interface NodeAdapter {
  report(input: ReportInput): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export function installNodeAdapter(opts: NodeAdapterOptions): NodeAdapter {
  const queue = new EventQueue(opts.sink);
  const detach: Array<() => void> = [];

  const enqueueError = (err: unknown, level: Level, manual: boolean) => {
    try {
      const event = buildEvent(err, level, manual, opts.projectKey, opts.runtime);
      queue.enqueue(event);
    } catch {
      // never let pixel break the host program
    }
  };

  const enqueueErrorSync = (err: unknown, level: Level, manual: boolean) => {
    try {
      const event = buildEvent(err, level, manual, opts.projectKey, opts.runtime);
      queue.enqueueSync(event);
    } catch {
      // never let pixel break the host program
    }
  };

  if (opts.captureUncaughtExceptions) {
    const handler = (err: Error) => enqueueErrorSync(err, "fatal", false);
    process.on("uncaughtExceptionMonitor", handler);
    detach.push(() => process.off("uncaughtExceptionMonitor", handler));
  }

  if (opts.captureUnhandledRejections) {
    const handler = (reason: unknown) => enqueueErrorSync(reason, "error", false);
    process.on("unhandledRejection", handler);
    detach.push(() => process.off("unhandledRejection", handler));
  }

  if (opts.captureConsoleErrors) {
    detach.push(patchConsole("error", (args) => enqueueError(consoleError(args), "error", false)));
  }

  if (opts.captureConsoleWarnings) {
    detach.push(patchConsole("warn", (args) => enqueueError(consoleError(args), "warning", false)));
  }

  if (opts.captureNetworkErrors) {
    const ignoreUrls = opts.ignoreNetworkUrls ?? [];
    const onObs = (obs: NetworkObservation) => {
      if (!shouldReportNetwork(obs)) return;
      enqueueError(networkObservationToError(obs), "error", false);
    };
    detach.push(installUndiciInstrumentation({ onEvent: onObs, ignoreUrls }));
  }

  const onBeforeExit = () => {
    void queue.flush();
  };
  process.on("beforeExit", onBeforeExit);
  detach.push(() => process.off("beforeExit", onBeforeExit));

  return {
    report(input: ReportInput) {
      const level = input.level ?? "error";
      if (input.error !== undefined) {
        try {
          const event = buildEvent(input.error, level, true, opts.projectKey, opts.runtime);
          if (input.message) event.message = input.message;
          queue.enqueue(event);
        } catch {
          // never let pixel break the host program
        }
        return;
      }
      const err = new Error(input.message);
      err.name = "ManualReport";
      enqueueError(err, level, true);
    },
    flush: () => queue.flush(),
    close: async () => {
      for (const fn of detach) fn();
      await queue.close();
    },
  };
}

function buildEvent(
  err: unknown,
  level: Level,
  manual: boolean,
  projectKey: string,
  runtime: string,
): WireEvent {
  const { type, message, stackString } = normalize(err);
  const stack = parseStack(stackString);
  return {
    event_id: randomUUID(),
    project_key: projectKey,
    fingerprint: fingerprint(type, stack),
    type,
    message,
    stack,
    code_context: captureCodeContext(stack),
    runtime,
    manual_report: manual,
    level,
    occurred_at: new Date().toISOString(),
  };
}

function normalize(err: unknown): { type: string; message: string; stackString?: string } {
  if (err instanceof Error) {
    return { type: err.name || "Error", message: err.message, stackString: err.stack };
  }
  if (typeof err === "string") {
    return { type: "StringError", message: err };
  }
  try {
    return { type: "UnknownError", message: JSON.stringify(err) };
  } catch {
    return { type: "UnknownError", message: String(err) };
  }
}

interface UndiciRequestLike {
  origin?: string;
  path?: string;
  method?: string;
}
interface UndiciResponseLike {
  statusCode?: number;
}

/**
 * Subscribe to undici's diagnostics_channel events. This is the canonical
 * Node hook used by Sentry, DataDog, NewRelic, AWS Powertools, and Node's
 * own internal inspector — and crucially, it covers BOTH `globalThis.fetch`
 * (built on undici since Node 18) and any library that uses undici clients
 * directly. Patching `globalThis.fetch` would double-count.
 */
function installUndiciInstrumentation(opts: {
  onEvent: (obs: NetworkObservation) => void;
  ignoreUrls: string[];
}): () => void {
  const requests = new WeakMap<object, { url: string; method: string; start: number }>();

  const onCreate = (msg: unknown): void => {
    const m = msg as { request?: UndiciRequestLike };
    const r = m.request;
    if (!r || typeof r !== "object") return;
    const url = `${r.origin ?? ""}${r.path ?? ""}`;
    if (
      opts.ignoreUrls.length > 0 &&
      opts.ignoreUrls.some((s) => url.toLowerCase().includes(s.toLowerCase()))
    ) {
      return;
    }
    requests.set(r as object, { url, method: r.method ?? "GET", start: Date.now() });
  };

  const onHeaders = (msg: unknown): void => {
    const m = msg as { request?: UndiciRequestLike; response?: UndiciResponseLike };
    if (!m.request) return;
    const meta = requests.get(m.request as object);
    if (!meta) return;
    const status = m.response?.statusCode ?? 0;
    opts.onEvent({
      url: meta.url,
      method: meta.method,
      status,
      duration_ms: Date.now() - meta.start,
    });
    requests.delete(m.request as object);
  };

  const onError = (msg: unknown): void => {
    const m = msg as { request?: UndiciRequestLike; error?: unknown };
    if (!m.request) return;
    const meta = requests.get(m.request as object);
    if (!meta) return;
    const error = m.error instanceof Error ? m.error : new Error(String(m.error));
    opts.onEvent({
      url: meta.url,
      method: meta.method,
      status: 0,
      duration_ms: Date.now() - meta.start,
      error,
    });
    requests.delete(m.request as object);
  };

  diagnosticsChannel.subscribe("undici:request:create", onCreate);
  diagnosticsChannel.subscribe("undici:request:headers", onHeaders);
  diagnosticsChannel.subscribe("undici:request:error", onError);

  return () => {
    diagnosticsChannel.unsubscribe("undici:request:create", onCreate);
    diagnosticsChannel.unsubscribe("undici:request:headers", onHeaders);
    diagnosticsChannel.unsubscribe("undici:request:error", onError);
  };
}

function consoleError(args: unknown[]): unknown {
  for (const a of args) if (a instanceof Error) return a;
  return new Error(args.map(stringify).join(" "));
}

function stringify(x: unknown): string {
  if (typeof x === "string") return x;
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

type ConsoleMethod = "error" | "warn";

function patchConsole(method: ConsoleMethod, onCall: (args: unknown[]) => void): () => void {
  const original = console[method];
  console[method] = (...args: unknown[]) => {
    try {
      onCall(args);
    } catch {
      // never let pixel break the host program
    }
    original.apply(console, args);
  };
  return () => {
    console[method] = original;
  };
}
