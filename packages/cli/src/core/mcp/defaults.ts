import type { Provider } from "@prestyj/ai";
import type { MCPServerConfig } from "./types.js";
import { loadServers } from "./store.js";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const KENCODE_PACKAGE = "@kenkaiiii/kencode-search";

/**
 * Resolve the kencode-search MCP server config.
 *
 * Prefer the locally installed package (it's a hard dependency of `@prestyj/cli`)
 * and run its bin directly with the current Node binary. This avoids `npx`'s
 * registry resolution, which is slow on a cold cache and flaky under the
 * concurrency of many sub-agent/goal-worker child processes booting at once —
 * the root cause of the "Unknown tool: mcp__kencode-search__*" failures.
 *
 * `StdioClientTransport` forces the child's cwd to the user's homedir, so a
 * project-local `npx` wouldn't find the install anyway; resolving the absolute
 * bin path here works regardless of cwd. Falls back to `npx -y` only when the
 * package can't be resolved (e.g. a partial install).
 */
function resolveKencodeServer(): MCPServerConfig {
  try {
    const require = createRequire(import.meta.url);
    const pkgJsonPath = require.resolve(`${KENCODE_PACKAGE}/package.json`);
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
      bin?: string | Record<string, string>;
      main?: string;
    };
    const binRel =
      typeof pkg.bin === "string"
        ? pkg.bin
        : (pkg.bin?.["kencode-search"] ?? Object.values(pkg.bin ?? {})[0] ?? pkg.main);
    if (binRel) {
      const binPath = path.join(path.dirname(pkgJsonPath), binRel);
      if (existsSync(binPath)) {
        return { name: "kencode-search", command: process.execPath, args: [binPath] };
      }
    }
  } catch {
    // Fall through to the npx fallback below.
  }
  return { name: "kencode-search", command: "npx", args: ["-y", KENCODE_PACKAGE] };
}

export const DEFAULT_MCP_SERVERS: MCPServerConfig[] = [resolveKencodeServer()];

/**
 * Get MCP servers for a specific provider.
 * GLM models get Z.AI MCP servers for vision, web search, web reading, and GitHub exploration.
 */
export function getMCPServers(provider: Provider, apiKey?: string): MCPServerConfig[] {
  const servers = [...DEFAULT_MCP_SERVERS];

  if (provider === "glm" && apiKey) {
    const zaiAuth = { Authorization: `Bearer ${apiKey}` };

    // Vision (image support via stdio MCP server)
    servers.push({
      name: "zai_vision",
      command: "npx",
      args: ["-y", "@z_ai/mcp-server"],
      env: {
        Z_AI_API_KEY: apiKey,
        Z_AI_MODE: "ZAI",
      },
      timeout: 60_000,
    });

    // Web search
    servers.push({
      name: "zai_web_search",
      url: "https://api.z.ai/api/mcp/web_search_prime/mcp",
      headers: zaiAuth,
      timeout: 60_000,
    });

    // Web reader (full-page content extraction)
    servers.push({
      name: "zai_web_reader",
      url: "https://api.z.ai/api/mcp/web_reader/mcp",
      headers: zaiAuth,
      timeout: 60_000,
    });

    // GitHub repository exploration
    servers.push({
      name: "zai_zread",
      url: "https://api.z.ai/api/mcp/zread/mcp",
      headers: zaiAuth,
      timeout: 60_000,
    });
  }

  return servers;
}

/**
 * Full startup set: provider defaults + user-configured servers from
 * ~/.ezcoder/mcp.json and ./.gg/mcp.json. Provider defaults stay authoritative —
 * a user server can only ADD a new name, never override a default like
 * `kencode-search`.
 */
export async function getAllMcpServers(
  provider: Provider,
  apiKey: string | undefined,
  cwd: string,
): Promise<MCPServerConfig[]> {
  const defaults = getMCPServers(provider, apiKey);
  const defaultNames = new Set(defaults.map((s) => s.name));
  const scoped = await loadServers(cwd);
  const userServers = scoped.map((s) => s.config).filter((c) => !defaultNames.has(c.name));
  return [...defaults, ...userServers];
}
