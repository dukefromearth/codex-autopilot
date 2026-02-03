/**
 * Adapter factory.
 */

import type { AgentAdapter, AdapterName } from "./types.js";

/**
 * Create an adapter by name.
 * Throws if adapter is not available.
 */
export async function createAdapter(name: AdapterName): Promise<AgentAdapter> {
  switch (name) {
    case "claude": {
      const { ClaudeAdapter } = await import("./claude.js");
      return new ClaudeAdapter();
    }
    case "codex": {
      const { CodexAdapter } = await import("./codex.js");
      return new CodexAdapter();
    }
    default:
      throw new Error(`Unknown adapter: ${name}`);
  }
}
