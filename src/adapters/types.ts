/**
 * Adapter interface for agent execution.
 * Abstracts the differences between Claude SDK and Codex SDK.
 */

export type AdapterName = "claude" | "codex";

export interface ExecuteParams {
  prompt: string;
  cwd: string;
  model?: string;
  options?: Record<string, unknown>;
}

export interface ExecuteResult {
  sessionId: string;
  outputText: string;
  status: "succeeded" | "failed";
  usage?: { inputTokens: number; outputTokens: number };
}

export interface AgentAdapter {
  readonly name: AdapterName;
  execute(params: ExecuteParams): Promise<ExecuteResult>;
  resume(
    sessionId: string,
    prompt: string,
    params?: Partial<ExecuteParams>
  ): Promise<ExecuteResult>;
}
