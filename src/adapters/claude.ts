/**
 * Claude SDK adapter.
 *
 * This adapter uses the Claude Agent SDK to execute prompts.
 * Skills are loaded via settingSources: ["project"].
 */

import type { AgentAdapter, ExecuteParams, ExecuteResult } from "./types.js";

export class ClaudeAdapter implements AgentAdapter {
  readonly name = "claude" as const;

  async execute(params: ExecuteParams): Promise<ExecuteResult> {
    // TODO: Implement with real Claude Agent SDK
    // For now, throw to indicate not yet implemented
    throw new Error(
      "ClaudeAdapter.execute() not yet implemented. " +
      "Install claude-agent-sdk and implement the query() integration."
    );
  }

  async resume(
    sessionId: string,
    prompt: string,
    params?: Partial<ExecuteParams>
  ): Promise<ExecuteResult> {
    // Resume is execute with resume option
    return this.execute({
      prompt,
      cwd: params?.cwd ?? process.cwd(),
      ...params,
      options: {
        ...params?.options,
        resume: sessionId,
      },
    });
  }
}
