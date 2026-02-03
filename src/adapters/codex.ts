/**
 * Codex SDK adapter.
 *
 * This adapter wraps the existing Codex CLI execution logic.
 * To be implemented by extracting from examples/codex-autopilot.ts.
 */

import type { AgentAdapter, ExecuteParams, ExecuteResult } from "./types.js";

export class CodexAdapter implements AgentAdapter {
  readonly name = "codex" as const;

  async execute(params: ExecuteParams): Promise<ExecuteResult> {
    // TODO: Extract from examples/codex-autopilot.ts codexExec()
    throw new Error(
      "CodexAdapter.execute() not yet implemented. " +
      "Extract codexExec() logic from examples/codex-autopilot.ts."
    );
  }

  async resume(
    sessionId: string,
    prompt: string,
    params?: Partial<ExecuteParams>
  ): Promise<ExecuteResult> {
    return this.execute({
      prompt,
      cwd: params?.cwd ?? process.cwd(),
      ...params,
      options: {
        ...params?.options,
        resumeThreadId: sessionId,
      },
    });
  }
}
