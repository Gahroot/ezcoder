// Which remote Playwright server the `browser` tool connects to, if any.
// Default is unchanged (launch a local Chromium). A remote browser is used when
//   - EZCODER_BROWSER_WS is a ws:// endpoint, or
//   - this session selected a fleet browser service (fleet tool `use`), or
//   - EZCODER_FLEET_BROWSER / fleet settings `browser` names one (id or node/name).
import { readFleetSettings, JsonListStore, defaultFleetDir } from "./store.js";
import type { FleetServiceRecord } from "./types.js";

let selected: string | undefined;

/** Make this process's `browser` tool use a fleet browser service (undefined = local). */
export function selectFleetBrowser(serviceRef: string | undefined): void {
  selected = serviceRef;
}

export function selectedFleetBrowser(): string | undefined {
  return selected;
}

/** Forget the selection when that service stops. */
export function clearSelectedFleetBrowser(serviceId: string): void {
  if (selected === serviceId) selected = undefined;
}

/** ws:// endpoint of a browser service record (its "playwright" port). */
export function browserWsEndpoint(s: FleetServiceRecord): string | undefined {
  const ep = s.endpoints.find((e) => e.name === "playwright") ?? s.endpoints[0];
  if (!ep) return undefined;
  return ep.url.replace(/^http(s?):\/\//, "ws$1://");
}

/** The endpoint the browser tool should connect to, or undefined to launch locally. */
export async function resolveBrowserWsEndpoint(
  opts: { env?: NodeJS.ProcessEnv; dir?: string } = {},
): Promise<string | undefined> {
  const env = opts.env ?? process.env;
  const direct = env.EZCODER_BROWSER_WS?.trim();
  if (direct) return direct;
  const dir = opts.dir ?? defaultFleetDir();
  const ref = selected ?? env.EZCODER_FLEET_BROWSER?.trim() ?? readFleetSettings(dir).browser;
  if (!ref) return undefined;
  const list = await new JsonListStore<FleetServiceRecord>(dir, "services.json", "services").read();
  const live = list.filter((s) => s.kind === "browser" && s.state === "running");
  const [node, name] = ref.includes("/") ? ref.split("/", 2) : [undefined, ref];
  const rec =
    live.find((s) => s.id === ref) ??
    live.filter((s) => s.name === name && (!node || s.node === node)).at(-1);
  if (!rec) {
    throw new Error(
      `fleet browser "${ref}" isn't running; start it with \`ezcoder fleet service up browser\` or unset it to use a local browser`,
    );
  }
  const ws = browserWsEndpoint(rec);
  if (!ws) throw new Error(`fleet browser ${rec.id} has no endpoint yet`);
  return ws;
}
