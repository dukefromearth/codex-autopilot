/**
 * Main autopilot runner.
 *
 * Orchestrates workflow generation, execution, and completion checking.
 */

import type { AgentAdapter } from "./adapters/types.js";
import type { Workflow, StepResult, CompletionCheck } from "./workflow/types.js";
import type { RunManifest, RunContext, RunOptions, RunState } from "./state/types.js";
import { parseWorkflow, normalizeWorkflow } from "./workflow/parser.js";
import {
  buildStepPrompt,
  buildWorkflowGenPrompt,
  buildCompletionCheckPrompt,
  buildCarrySummary,
} from "./workflow/prompt.js";
import { findReadySteps } from "./workflow/executor.js";
import { safeJsonParse } from "./utils/json.js";
import {
  initializeRun,
  writeManifest,
  addExecToManifest,
  addDependsOnEdge,
  addInvokesEdge,
  finalizeRun,
} from "./state/manifest.js";
import {
  allocateExecId,
  writeExecArtifacts,
  createExecEntry,
} from "./state/artifacts.js";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export interface RunnerParams {
  task: string;
  adapter: AgentAdapter;
  options: RunOptions;
  outDir: string;
}

export interface RunnerResult {
  status: "completed" | "max-iterations" | "error";
  runId: string;
  summary?: string;
  error?: string;
}

/**
 * Run the autopilot loop.
 */
export async function run(params: RunnerParams): Promise<RunnerResult> {
  const { task, adapter, options, outDir } = params;
  const { context, manifest } = await initializeRun(task, options, outDir);

  const runState: RunState = {
    task,
    options,
    iterations: [],
  };

  let carrySummary = "";
  let nextWorkflowOverride: Workflow | null = null;

  try {
    for (let iteration = 1; iteration <= options.maxIterations; iteration++) {
      // Generate or use override workflow
      let workflow: Workflow;
      let workflowGenExecId: string | null = null;

      if (nextWorkflowOverride) {
        workflow = nextWorkflowOverride;
        nextWorkflowOverride = null;
      } else {
        const genResult = await generateWorkflow(
          task,
          carrySummary,
          iteration,
          adapter,
          context,
          manifest
        );
        workflow = genResult.workflow;
        workflowGenExecId = genResult.execId;
      }

      console.log(
        `\n[autopilot] Iteration ${iteration}: workflow=${workflow.id} steps=${workflow.steps.length}`
      );

      // Execute workflow steps
      const stepResults = await executeWorkflow(
        workflow,
        task,
        adapter,
        context,
        manifest,
        options.concurrency
      );

      // Record workflow dependencies in graph
      recordWorkflowEdges(workflow, stepResults, workflowGenExecId, manifest);

      // Check completion
      const completionResult = await checkCompletion(
        task,
        workflow,
        stepResults,
        iteration,
        adapter,
        context,
        manifest
      );

      // Record invokes edges from steps to completion check
      for (const step of stepResults) {
        if (step.sessionId) {
          addInvokesEdge(manifest, step.sessionId, completionResult.execId);
        }
      }

      await writeManifest(context, manifest);

      // Save iteration state
      runState.iterations.push({
        index: iteration,
        workflow,
        steps: stepResults,
        completion: completionResult.completion,
      });
      await writeRunState(context, runState);

      if (completionResult.completion.done) {
        finalizeRun(manifest);
        await writeManifest(context, manifest);
        console.log("\n[autopilot] Done.");
        console.log(completionResult.completion.summary || "(no summary)");
        return {
          status: "completed",
          runId: context.runId,
          summary: completionResult.completion.summary,
        };
      }

      console.log(`\n[autopilot] Not done: ${completionResult.completion.reason}`);

      if (completionResult.completion.nextWorkflow) {
        console.log("[autopilot] Reviewer provided next workflow; continuing.\n");
        nextWorkflowOverride = completionResult.completion.nextWorkflow;
      }

      carrySummary = buildCarrySummary(workflow, stepResults, completionResult.completion);
    }

    finalizeRun(manifest);
    await writeManifest(context, manifest);
    console.log(`\n[autopilot] Stopped after maxIterations=${options.maxIterations}`);

    return {
      status: "max-iterations",
      runId: context.runId,
    };
  } catch (error) {
    finalizeRun(manifest);
    await writeManifest(context, manifest);
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      runId: context.runId,
      error: message,
    };
  }
}

async function generateWorkflow(
  task: string,
  carrySummary: string,
  iteration: number,
  adapter: AgentAdapter,
  context: RunContext,
  manifest: RunManifest
): Promise<{ workflow: Workflow; execId: string }> {
  const prompt = buildWorkflowGenPrompt(task, iteration, carrySummary);
  const execId = allocateExecId(context);
  const label = `workflow-gen:iteration-${iteration}`;
  const startedAt = new Date().toISOString();

  const result = await adapter.execute({
    prompt,
    cwd: context.cwd,
    model: context.options.model,
    options: { unsafe: context.options.unsafe },
  });

  const finishedAt = new Date().toISOString();
  const artifacts = await writeExecArtifacts(
    context,
    execId,
    label,
    prompt,
    result.outputText,
    { sessionId: result.sessionId, usage: result.usage }
  );

  const entry = createExecEntry(
    execId,
    label,
    result.sessionId,
    result.status,
    startedAt,
    finishedAt,
    artifacts
  );
  addExecToManifest(manifest, entry);
  await writeManifest(context, manifest);

  const workflow = parseWorkflow(result.outputText);
  return { workflow, execId };
}

async function executeWorkflow(
  workflow: Workflow,
  task: string,
  adapter: AgentAdapter,
  context: RunContext,
  manifest: RunManifest,
  concurrency: number
): Promise<StepResult[]> {
  const completed = new Map<string, StepResult>();
  const pending = new Set(workflow.steps.map((s) => s.id));
  const running = new Set<string>();

  while (pending.size > 0) {
    const ready = findReadySteps(
      workflow.steps.filter((s) => pending.has(s.id)),
      new Set(completed.keys()),
      running
    );

    if (ready.length === 0 && running.size === 0) {
      throw new Error(`Workflow stuck: cannot resolve remaining steps`);
    }

    const slots = Math.max(1, concurrency) - running.size;
    const wave = ready.slice(0, Math.max(1, slots));

    for (const step of wave) {
      running.add(step.id);
    }

    const results = await Promise.all(
      wave.map((step) => executeStep(step, completed, task, adapter, context, manifest))
    );

    for (const result of results) {
      completed.set(result.stepId, result);
      pending.delete(result.stepId);
      running.delete(result.stepId);
      console.log(
        `[step:${result.stepId}] ${result.status} session=${result.sessionId}${
          result.error ? ` error=${result.error}` : ""
        }`
      );
    }
  }

  return workflow.steps.map((s) => completed.get(s.id)!);
}

async function executeStep(
  step: { id: string; goal: string; dependsOn?: string[] },
  completed: Map<string, StepResult>,
  task: string,
  adapter: AgentAdapter,
  context: RunContext,
  manifest: RunManifest
): Promise<StepResult> {
  const prompt = buildStepPrompt(step as any, completed, task);
  const execId = allocateExecId(context);
  const label = `step:${step.id}`;
  const startedAt = new Date().toISOString();

  try {
    const result = await adapter.execute({
      prompt,
      cwd: context.cwd,
      model: context.options.model,
      options: { unsafe: context.options.unsafe },
    });

    const finishedAt = new Date().toISOString();
    const artifacts = await writeExecArtifacts(
      context,
      execId,
      label,
      prompt,
      result.outputText,
      { sessionId: result.sessionId, usage: result.usage }
    );

    const entry = createExecEntry(
      execId,
      label,
      result.sessionId,
      result.status,
      startedAt,
      finishedAt,
      artifacts
    );
    addExecToManifest(manifest, entry);

    return {
      stepId: step.id,
      status: result.status,
      sessionId: result.sessionId,
      outputText: result.outputText,
      usage: result.usage,
    };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const errorMsg = error instanceof Error ? error.message : String(error);
    const artifacts = await writeExecArtifacts(
      context,
      execId,
      label,
      prompt,
      `Error: ${errorMsg}`,
      { error: errorMsg }
    );

    const entry = createExecEntry(
      execId,
      label,
      "",
      "failed",
      startedAt,
      finishedAt,
      artifacts
    );
    addExecToManifest(manifest, entry);

    return {
      stepId: step.id,
      status: "failed",
      sessionId: "",
      outputText: "",
      error: errorMsg,
    };
  }
}

async function checkCompletion(
  task: string,
  workflow: Workflow,
  results: StepResult[],
  iteration: number,
  adapter: AgentAdapter,
  context: RunContext,
  manifest: RunManifest
): Promise<{ completion: CompletionCheck; execId: string }> {
  const prompt = buildCompletionCheckPrompt(task, workflow, results, iteration);
  const execId = allocateExecId(context);
  const label = `completion-check:iteration-${iteration}`;
  const startedAt = new Date().toISOString();

  const result = await adapter.execute({
    prompt,
    cwd: context.cwd,
    model: context.options.model,
    options: { unsafe: context.options.unsafe },
  });

  const finishedAt = new Date().toISOString();
  const artifacts = await writeExecArtifacts(
    context,
    execId,
    label,
    prompt,
    result.outputText,
    { sessionId: result.sessionId, usage: result.usage }
  );

  const entry = createExecEntry(
    execId,
    label,
    result.sessionId,
    result.status,
    startedAt,
    finishedAt,
    artifacts
  );
  addExecToManifest(manifest, entry);

  const parsed = safeJsonParse(result.outputText);
  if (!parsed || typeof parsed !== "object") {
    return {
      completion: { done: false, reason: "Reviewer returned invalid JSON" },
      execId,
    };
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.done === true) {
    return {
      completion: {
        done: true,
        summary: String(obj.summary ?? "Done."),
      },
      execId,
    };
  }

  const reason = String(obj.reason ?? "Not done.");
  const nextWorkflow = obj.nextWorkflow
    ? normalizeWorkflow(obj.nextWorkflow)
    : undefined;

  return {
    completion: { done: false, reason, nextWorkflow },
    execId,
  };
}

function recordWorkflowEdges(
  workflow: Workflow,
  results: StepResult[],
  workflowGenExecId: string | null,
  manifest: RunManifest
): void {
  const execByStep = new Map<string, string>();
  for (const result of results) {
    if (result.sessionId) {
      execByStep.set(result.stepId, result.sessionId);
    }
  }

  // Record dependsOn edges
  for (const step of workflow.steps) {
    const stepExecId = execByStep.get(step.id);
    if (!stepExecId || !step.dependsOn) continue;

    for (const dep of step.dependsOn) {
      const depExecId = execByStep.get(dep);
      if (depExecId) {
        addDependsOnEdge(manifest, depExecId, stepExecId);
      }
    }
  }

  // Record invokes edges from workflow gen to steps
  if (workflowGenExecId) {
    for (const result of results) {
      if (result.sessionId) {
        addInvokesEdge(manifest, workflowGenExecId, result.sessionId);
      }
    }
  }
}

async function writeRunState(context: RunContext, state: RunState): Promise<void> {
  const statePath = path.join(path.dirname(context.runDir), `${context.runId}.json`);
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}
