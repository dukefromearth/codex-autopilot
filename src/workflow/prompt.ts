/**
 * Prompt construction for workflow generation and step execution.
 */

import type { WorkflowStep, StepResult, Workflow, CompletionCheck } from "./types.js";
import { truncate } from "../utils/json.js";

/**
 * Build prompt for a workflow step execution.
 */
export function buildStepPrompt(
  step: WorkflowStep,
  completed: Map<string, StepResult>,
  task: string
): string {
  const blocks: string[] = [];

  blocks.push(step.goal.trim());
  blocks.push("");
  blocks.push(`Overall task: ${task}`);

  const deps = (step.dependsOn ?? [])
    .map((depId) => completed.get(depId))
    .filter((dep): dep is StepResult => dep !== undefined);

  if (deps.length > 0) {
    blocks.push("");
    blocks.push("Dependency outputs:");
    for (const dep of deps) {
      blocks.push(`\n--- ${dep.stepId} (${dep.status}) ---\n`);
      blocks.push(dep.outputText || "(empty)");
    }
  }

  if (typeof step.context === "string" && step.context.trim()) {
    blocks.push("");
    blocks.push("Additional context:");
    blocks.push(step.context.trim());
  }

  blocks.push("");
  blocks.push("If you make code changes, run the most relevant checks/tests and report results.");
  blocks.push("Finish with a short 'Done' summary and any remaining risks.");

  return blocks.join("\n");
}

/**
 * Build prompt for workflow generation.
 */
export function buildWorkflowGenPrompt(
  task: string,
  iteration: number,
  carrySummary: string
): string {
  const parts: string[] = [];

  parts.push("use the workflow-generator skill.");
  parts.push("");
  parts.push(`Task: ${task}`);

  if (carrySummary.trim()) {
    parts.push("");
    parts.push("Context from previous iterations:");
    parts.push(carrySummary);
  }

  parts.push("");
  parts.push("Output ONLY valid JSON for a workflow object with fields:");
  parts.push("- version (1)");
  parts.push("- id (string)");
  parts.push('- steps: array of { id, type:"agent.run", goal, dependsOn? }');
  parts.push("");
  parts.push("Rules:");
  parts.push('- Keep it small (<= 8 steps). Prefer parallel research → execute → verify → summarize.');
  parts.push('- Every step.goal MUST begin with: "use the <skill> skill."');
  parts.push("- Use only skills that exist in this workspace.");
  parts.push("- Use dependsOn to express data dependencies.");
  parts.push("- If iteration > 1, focus only on remaining work (do not repeat completed steps).");
  parts.push("");
  parts.push(`Iteration: ${iteration}`);

  return parts.join("\n");
}

/**
 * Build prompt for completion check.
 */
export function buildCompletionCheckPrompt(
  task: string,
  workflow: Workflow,
  results: StepResult[],
  iteration: number
): string {
  const condensed = results.map((r) => ({
    stepId: r.stepId,
    status: r.status,
    sessionId: r.sessionId,
    output: truncate(r.outputText, 18_000),
    error: r.error,
  }));

  const parts: string[] = [];

  parts.push("use the reviewer skill.");
  parts.push("");
  parts.push(`Task: ${task}`);
  parts.push(`Iteration: ${iteration}`);
  parts.push("");
  parts.push("Here are the workflow results (JSON):");
  parts.push(JSON.stringify({ workflowId: workflow.id, results: condensed }, null, 2));
  parts.push("");
  parts.push("Return JSON ONLY with one of these shapes:");
  parts.push('1) {"done":true,"summary":"..."}');
  parts.push('2) {"done":false,"reason":"...","nextWorkflow":{...workflow json...}}');
  parts.push("");
  parts.push("Rules:");
  parts.push("- Be strict: done=true only if the task is actually completed.");
  parts.push("- If not done, provide a small nextWorkflow (<= 6 steps) that finishes the remaining work.");
  parts.push('- nextWorkflow steps should begin with: "use the <skill> skill."');

  return parts.join("\n");
}

/**
 * Build carry summary for next iteration.
 */
export function buildCarrySummary(
  workflow: Workflow,
  results: StepResult[],
  completion: CompletionCheck
): string {
  const lines: string[] = [];

  lines.push(`Previous workflow: ${workflow.id}`);
  lines.push("Step statuses:");

  for (const r of results) {
    lines.push(`- ${r.stepId}: ${r.status} (session ${r.sessionId})`);
    if (r.error) {
      lines.push(`  error: ${r.error}`);
    }
  }

  if (!completion.done) {
    lines.push(`Reviewer: not done (${completion.reason})`);
  }

  return lines.join("\n");
}
