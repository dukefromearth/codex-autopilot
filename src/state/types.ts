/**
 * State and manifest types for run persistence.
 */

import type { Workflow, StepResult, CompletionCheck } from "../workflow/types.js";

export type RunOptions = {
  adapter: "claude" | "codex";
  model: string;
  concurrency: number;
  maxIterations: number;
  unsafe: boolean;
};

export type ExecArtifacts = {
  promptTxt: string;
  outputTxt: string;
  metadataJson: string;
};

export type ExecEntry = {
  execId: string;
  label: string;
  sessionId: string;
  status: "succeeded" | "failed";
  startedAt: string;
  finishedAt: string;
  artifacts: ExecArtifacts;
};

export type GraphNode = {
  id: string;
  type: "exec";
  execId: string;
  label: string;
  sessionId: string;
};

export type GraphEdge = {
  type: "dependsOn" | "invokes";
  from: string;
  to: string;
};

export type RunManifest = {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  cwd: string;
  options: RunOptions;
  execs: ExecEntry[];
  graph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
    warnings: string[];
  };
};

export type RunState = {
  task: string;
  options: RunOptions;
  iterations: Array<{
    index: number;
    workflow: Workflow;
    steps: StepResult[];
    completion: CompletionCheck;
  }>;
};

export type RunContext = {
  runId: string;
  runDir: string;
  task: string;
  cwd: string;
  options: RunOptions;
  nextExecIndex: number;
};
