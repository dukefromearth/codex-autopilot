/**
 * Mock adapter for testing.
 */

import type { AgentAdapter, ExecuteParams, ExecuteResult } from "./types.js";

export type MockResponse = {
  sessionId: string;
  outputText: string;
  status: "succeeded" | "failed";
  usage?: { inputTokens: number; outputTokens: number };
};

/**
 * Mock adapter that returns predefined responses.
 */
export class MockAdapter implements AgentAdapter {
  readonly name = "claude" as const;
  private responses: MockResponse[];
  private callIndex = 0;
  public calls: ExecuteParams[] = [];

  constructor(responses: MockResponse[]) {
    this.responses = responses;
  }

  async execute(params: ExecuteParams): Promise<ExecuteResult> {
    this.calls.push(params);
    const response = this.responses[this.callIndex] ?? {
      sessionId: `mock-session-${this.callIndex}`,
      outputText: "Mock response",
      status: "succeeded" as const,
    };
    this.callIndex++;
    return response;
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
    });
  }
}
