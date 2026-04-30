/**
 * Outgoing-request instrumentation shared between browser and Node adapters.
 *
 * Browser: monkey-patches `globalThis.fetch` and `XMLHttpRequest.prototype`.
 * Node: subscribes to undici's `diagnostics_channel` (covers both native
 * fetch and any library on undici under the hood — that's why Node does NOT
 * patch fetch directly; it would double-count).
 *
 * Pattern verified against Sentry, DataDog, NewRelic, AWS Powertools, and
 * Node's own internal inspector — they all subscribe to the same set of
 * undici channels (`request:create` / `:headers` / `:error`).
 */

export interface NetworkObservation {
  url: string;
  method: string;
  /** HTTP status code, or 0 if the request threw before getting one. */
  status: number;
  duration_ms: number;
  /** Set when the request threw (DNS failure, abort, network down, etc). */
  error?: Error;
}

export interface NetworkInstrumentationOptions {
  onEvent: (obs: NetworkObservation) => void;
  /** URLs containing any of these substrings are ignored (case-insensitive). */
  ignoreUrls?: string[];
}

/** Returns an unhook fn. No-op if `globalThis.fetch` is missing. */
export function installFetchInstrumentation(opts: NetworkInstrumentationOptions): () => void {
  const target = globalThis as { fetch?: typeof fetch };
  const original = target.fetch;
  if (typeof original !== "function") return () => {};

  // If we've already wrapped (double-init), don't re-wrap.
  const marker = "__ezPixelWrapped";
  if ((original as unknown as Record<string, unknown>)[marker]) return () => {};

  const wrapped: typeof fetch = function patchedFetch(input, init) {
    const url = resolveFetchUrl(input);
    const method = resolveFetchMethod(input, init);
    if (shouldIgnore(url, opts.ignoreUrls)) {
      return original!.call(globalThis, input as RequestInfo, init);
    }
    const start = Date.now();
    return original!.call(globalThis, input as RequestInfo, init).then(
      (res) => {
        opts.onEvent({ url, method, status: res.status, duration_ms: Date.now() - start });
        return res;
      },
      (err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        opts.onEvent({ url, method, status: 0, duration_ms: Date.now() - start, error });
        throw err;
      },
    );
  };
  Object.defineProperty(wrapped, marker, { value: true });
  target.fetch = wrapped;
  return () => {
    if (target.fetch === wrapped) target.fetch = original;
  };
}

/** Returns an unhook fn. No-op if `XMLHttpRequest` is missing. */
export function installXhrInstrumentation(opts: NetworkInstrumentationOptions): () => void {
  const X = (globalThis as { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest;
  if (typeof X === "undefined") return () => {};
  const proto = X.prototype;
  const originalOpen = proto.open;
  const originalSend = proto.send;

  // Symbol on the xhr instance for correlating open() → send() → loadend.
  const META = Symbol.for("ezPixelXhrMeta");
  type Meta = { method: string; url: string; start: number; ignored: boolean };

  proto.open = function patchedOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    const m = String(method).toUpperCase();
    const u = String(url);
    (this as unknown as Record<symbol, Meta>)[META] = {
      method: m,
      url: u,
      start: 0,
      ignored: shouldIgnore(u, opts.ignoreUrls),
    };
    return (originalOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof proto.open;

  proto.send = function patchedSend(
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    const meta = (this as unknown as Record<symbol, Meta | undefined>)[META];
    if (meta && !meta.ignored) {
      meta.start = Date.now();
      this.addEventListener("loadend", function onDone(this: XMLHttpRequest) {
        const duration_ms = Date.now() - meta.start;
        // status === 0 means the request never reached the server (network
        // failure, CORS rejection, abort). Synthesize an Error so downstream
        // policy can treat it as a real failure.
        if (this.status === 0) {
          opts.onEvent({
            url: meta.url,
            method: meta.method,
            status: 0,
            duration_ms,
            error: new Error(`xhr failed: ${meta.method} ${meta.url}`),
          });
        } else {
          opts.onEvent({
            url: meta.url,
            method: meta.method,
            status: this.status,
            duration_ms,
          });
        }
      });
    }
    return originalSend.call(this, body);
  } as typeof proto.send;

  return () => {
    proto.open = originalOpen;
    proto.send = originalSend;
  };
}

function resolveFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  // Request-like
  if (typeof input === "object" && input && "url" in input && typeof input.url === "string") {
    return input.url;
  }
  return String(input);
}

function resolveFetchMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (
    typeof input === "object" &&
    input &&
    "method" in input &&
    typeof (input as Request).method === "string"
  ) {
    return (input as Request).method.toUpperCase();
  }
  return "GET";
}

function shouldIgnore(url: string, ignoreUrls?: string[]): boolean {
  if (!ignoreUrls || ignoreUrls.length === 0) return false;
  const lower = url.toLowerCase();
  return ignoreUrls.some((s) => lower.includes(s.toLowerCase()));
}

/**
 * Default policy: a NetworkObservation becomes a pixel event when status >= 500
 * or the request threw. 4xx is intentionally dropped — it's almost always
 * "expected" (validation errors, auth failures) and would drown out signal.
 */
export function shouldReportNetwork(obs: NetworkObservation): boolean {
  if (obs.error) return true;
  return obs.status >= 500;
}

/** Render a NetworkObservation into a synthetic Error for the existing event pipeline. */
export function networkObservationToError(obs: NetworkObservation): Error {
  const reason = obs.error ? obs.error.message : `HTTP ${obs.status}`;
  const err = new Error(`${obs.method} ${obs.url} — ${reason} (${obs.duration_ms}ms)`);
  err.name = "NetworkError";
  if (obs.error?.stack) err.stack = obs.error.stack;
  return err;
}
