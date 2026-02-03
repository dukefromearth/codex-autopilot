/**
 * Codex Autopilot (one-file runner)
 *
 * Narrative:
 * - This file treats `codex exec` as both a compiler and a worker pool.
 * - First, it asks Codex (via the local `workflow-generator` skill) to "compile" a natural-language
 *   task into a small DAG of `agent.run` steps (a WorkflowSpec-like IR).
 * - Then it executes that DAG by spawning one `codex exec --json` process per step, in dependency
 *   order (with limited parallelism). Each step becomes its own Codex session (`thread_id`), which
 *   doubles as a durable checkpoint you can resume manually for HITL.
 * - After the DAG runs, it asks a reviewer to either declare completion (`done=true`) or emit a
 *   follow-up DAG for the next iteration (plan → run → replan).
 *
 * Business intent:
 * - Prove how much "emergent autonomy" you can get from minimal code by pushing decomposition,
 *   skill selection, and plan updates into skills + generated workflows, while keeping the runner
 *   dumb: schedule, pass dependency outputs forward, and record an audit log.
 *
 * Gotchas:
 * - Requires `codex` CLI on PATH and credentials configured for your environment.
 * - `--unsafe` disables approvals/sandboxing and can execute arbitrary commands; use only in an
 *   environment that is externally sandboxed and disposable.
 * - Dataflow is prompt-based (dependency outputs are pasted into downstream prompts); without
 *   strict per-step schemas, this is powerful but can be brittle at scale.
 */
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";

type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

type Workflow = {
  version: 1;
  id: string;
  name?: string;
  description?: string;
  concurrency?: number;
  steps: WorkflowStep[];
  defaults?: Record<string, unknown>;
};

type WorkflowStep = {
  id: string;
  type: "agent.run";
  goal: string;
  dependsOn?: string[];
  context?: string;
  adapterRequest?: Record<string, unknown>;
  // This runner intentionally accepts any additional fields emitted by a generator.
  [key: string]: unknown;
};

type CodexEvent =
  | { type: "thread.started"; thread_id: string }
  | { type: "turn.started" }
  | { type: "turn.completed"; usage?: unknown }
  | { type: "turn.failed"; error?: unknown }
  | { type: "error"; message?: unknown }
  | { type: "item.completed"; item?: unknown }
  | Record<string, unknown>;

type CodexRunResult = {
  execId: string;
  threadId: string;
  outputText: string;
  events: CodexEvent[];
  usage?: unknown;
};

class CodexExecError extends Error {
  execId: string;
  threadId: string;
  exitCode: number;

  constructor(message: string, params: { execId: string; threadId: string; exitCode: number }) {
    super(message);
    this.name = "CodexExecError";
    this.execId = params.execId;
    this.threadId = params.threadId;
    this.exitCode = params.exitCode;
  }
}

type ExecArtifactPaths = {
  eventsJsonl: string;
  stderrTxt: string;
  lastMessageTxt: string;
  promptTxt?: string;
  argvJson?: string;
  schemaJson?: string;
};

type ExecManifestEntry = {
  execId: string;
  label: string;
  threadId: string;
  status: "succeeded" | "failed";
  exitCode: number;
  startedAt: string;
  finishedAt: string;
  artifacts: ExecArtifactPaths;
};

type GraphNode =
  | {
      id: string;
      type: "exec";
      execId: string;
      label: string;
      threadId: string;
      artifacts: ExecArtifactPaths;
    }
  | {
      id: string;
      type: "thread";
      threadId: string;
    };

type GraphEdge = {
  type: "dependsOn" | "invokes" | "resume" | "spawn" | "interact";
  from: string;
  to: string;
  callId?: string;
  status?: string;
  prompt?: string;
  source?: "workflow" | "resume" | "transcript";
};

type RunManifest = {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  cwd: string;
  options: {
    model: string;
    effort: ReasoningEffort;
    concurrency: number;
    unsafe: boolean;
    search: boolean;
  };
  execs: ExecManifestEntry[];
  graph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
    warnings: string[];
  };
};

type CaptureContext = {
  runDir: string;
  runManifestPath: string;
  runManifest: RunManifest;
  nextExecIndex: number;
  manifestWrite: Promise<void>;
  graphIndex: {
    nodes: Map<string, GraphNode>;
    edges: Map<string, GraphEdge>;
    warnings: Set<string>;
    threadToExecNodes: Map<string, string[]>;
    transcriptThreads: Set<string>;
    transcriptCallIds: Map<string, string>;
  };
};

type StepResult = {
  stepId: string;
  status: "succeeded" | "failed";
  execId: string;
  threadId: string;
  outputText: string;
  usage?: unknown;
  error?: string;
};

type CompletionCheck =
  | { done: true; summary: string }
  | { done: false; reason: string; nextWorkflow?: Workflow };

type RunnerOptions = {
  task: string;
  model: string;
  effort: ReasoningEffort;
  concurrency: number;
  maxIterations: number;
  unsafe: boolean;
  search: boolean;
  outDir: string;
};

const DEFAULT_MODEL = "gpt-5.2-codex";
const DEFAULT_EFFORT: ReasoningEffort = "low";

const args = process.argv.slice(2);
const parsed = parseArgs(args);
if (!parsed) {
  printHelp();
  process.exit(1);
}

await run(parsed);

async function run(options: RunnerOptions): Promise<void> {
  await mkdir(options.outDir, { recursive: true });
  const runId = `autopilot-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const runFile = path.join(options.outDir, `${runId}.json`);
  const runDir = path.join(options.outDir, runId);
  const runManifestPath = path.join(runDir, "manifest.json");
  await mkdir(runDir, { recursive: true });

  const runManifest: RunManifest = {
    runId,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
    options: {
      model: options.model,
      effort: options.effort,
      concurrency: options.concurrency,
      unsafe: options.unsafe,
      search: options.search,
    },
    execs: [],
    graph: {
      nodes: [],
      edges: [],
      warnings: [],
    },
  };

  await writeFile(runManifestPath, JSON.stringify(runManifest, null, 2), "utf8");

  const runState: {
    task: string;
    model: string;
    effort: ReasoningEffort;
    unsafe: boolean;
    search: boolean;
    iterations: Array<{
      index: number;
      workflow: Workflow;
      steps: StepResult[];
      completion: CompletionCheck;
    }>;
  } = {
    task: options.task,
    model: options.model,
    effort: options.effort,
    unsafe: options.unsafe,
    search: options.search,
    iterations: [],
  };

  const captureContext = {
    runDir,
    runManifestPath,
    runManifest,
    nextExecIndex: 1,
    manifestWrite: Promise.resolve(),
    graphIndex: {
      nodes: new Map<string, GraphNode>(),
      edges: new Map<string, GraphEdge>(),
      warnings: new Set<string>(),
      threadToExecNodes: new Map<string, string[]>(),
      transcriptThreads: new Set<string>(),
      transcriptCallIds: new Map<string, string>(),
    },
  };

  let carrySummary = "";
  let nextWorkflowOverride: Workflow | null = null;
  let pendingCompletionExecId: string | null = null;
  for (let iteration = 1; iteration <= options.maxIterations; iteration += 1) {
    let workflow: Workflow;
    let workflowGenExecId: string | null = null;
    if (nextWorkflowOverride) {
      workflow = nextWorkflowOverride;
      workflowGenExecId = pendingCompletionExecId;
      pendingCompletionExecId = null;
    } else {
      const workflowGen = await generateWorkflow(
        options,
        carrySummary,
        iteration,
        captureContext,
      );
      workflow = workflowGen.workflow;
      workflowGenExecId = workflowGen.execId;
      if (pendingCompletionExecId && workflowGenExecId) {
        recordCompletionToWorkflowEdge(
          pendingCompletionExecId,
          workflowGenExecId,
          captureContext,
        );
        await writeManifest(captureContext);
      }
    }
    nextWorkflowOverride = null;
    console.log(`\n[autopilot] Iteration ${iteration}: workflow=${workflow.id} steps=${workflow.steps.length}`);

    const stepResults = await executeWorkflow(options, workflow, captureContext);
    recordWorkflowDependsOnEdges(workflow, stepResults, captureContext);
    const completionRun = await checkCompletion(
      options,
      workflow,
      stepResults,
      iteration,
      captureContext,
    );
    const completion = completionRun.completion;
    recordInvokesEdges(workflowGenExecId, stepResults, completionRun.execId, captureContext);
    await writeManifest(captureContext);

    runState.iterations.push({
      index: iteration,
      workflow,
      steps: stepResults,
      completion,
    });
    await writeFile(runFile, JSON.stringify(runState, null, 2), "utf8");

    if (completion.done) {
      runManifest.finishedAt = new Date().toISOString();
      await writeManifest(captureContext);
      console.log("\n[autopilot] Done.");
      console.log(completion.summary.trim() ? completion.summary : "(no summary)");
      console.log(`\n[autopilot] Run log: ${runFile}`);
      return;
    }

    console.log(`\n[autopilot] Not done: ${completion.reason}`);

    if (completion.nextWorkflow) {
      console.log("[autopilot] Reviewer provided next workflow; continuing.\n");
      carrySummary = formatCarrySummary(workflow, stepResults, completion);
      nextWorkflowOverride = completion.nextWorkflow;
      pendingCompletionExecId = completionRun.execId;
      continue;
    }

    carrySummary = formatCarrySummary(workflow, stepResults, completion);
    pendingCompletionExecId = completionRun.execId;
  }

  runManifest.finishedAt = new Date().toISOString();
  await writeManifest(captureContext);
  console.log(
    `\n[autopilot] Stopped after maxIterations=${options.maxIterations}. See run log: ${runFile}`,
  );
}

async function generateWorkflow(
  options: RunnerOptions,
  carrySummary: string,
  iteration: number,
  captureContext: CaptureContext,
): Promise<{ workflow: Workflow; execId: string }> {
  const promptParts: string[] = [];
  promptParts.push("use the workflow-generator skill.");
  promptParts.push("");
  promptParts.push(`Task: ${options.task}`);
  if (carrySummary.trim()) {
    promptParts.push("");
    promptParts.push("Context from previous iterations:");
    promptParts.push(carrySummary);
  }
  promptParts.push("");
  promptParts.push("Output ONLY valid JSON for a workflow object with fields:");
  promptParts.push("- version (1)");
  promptParts.push("- id (string)");
  promptParts.push("- steps: array of { id, type:\"agent.run\", goal, dependsOn? }");
  promptParts.push("");
  promptParts.push("Rules:");
  promptParts.push("- Keep it small (<= 8 steps). Prefer parallel research → execute → verify → summarize.");
  promptParts.push("- Every step.goal MUST begin with: \"use the <skill> skill.\"");
  promptParts.push("- Use only skills that exist in this workspace.");
  promptParts.push("- Use dependsOn to express data dependencies.");
  promptParts.push("- If iteration > 1, focus only on remaining work (do not repeat completed steps).");
  promptParts.push("");
  promptParts.push(`Iteration: ${iteration}`);

  const run = await codexExec({
    label: `workflow-gen:iteration-${iteration}`,
    prompt: promptParts.join("\n"),
    model: options.model,
    effort: options.effort,
    unsafe: options.unsafe,
    search: options.search,
    captureContext,
  });

  return { workflow: parseWorkflowJson(run.outputText), execId: run.execId };
}

async function executeWorkflow(
  options: RunnerOptions,
  workflow: Workflow,
  captureContext: CaptureContext,
): Promise<StepResult[]> {
  const byId = new Map<string, WorkflowStep>();
  for (const step of workflow.steps) {
    byId.set(step.id, step);
  }

  const remaining = new Set(workflow.steps.map((s) => s.id));
  const completed = new Set<string>();
  const running = new Set<string>();
  const results = new Map<string, StepResult>();

  const getDeps = (stepId: string): string[] => {
    const step = byId.get(stepId);
    if (!step) return [];
    return (Array.isArray(step.dependsOn) ? step.dependsOn : [])
      .map((dep) => String(dep).trim())
      .filter(Boolean);
  };

  while (remaining.size > 0) {
    const ready = Array.from(remaining).filter((stepId) => {
      if (running.has(stepId)) return false;
      const deps = getDeps(stepId);
      return deps.every((dep) => completed.has(dep));
    });

    if (ready.length === 0) {
      const stuck = Array.from(remaining).slice(0, 10).join(", ");
      throw new Error(
        `Workflow is stuck (missing deps or cycle). Remaining: ${stuck}`,
      );
    }

    const effectiveConcurrency = workflow.concurrency ?? options.concurrency;
    const slots = Math.max(1, effectiveConcurrency) - running.size;
    const wave = ready.slice(0, Math.max(1, slots));
    for (const stepId of wave) {
      running.add(stepId);
    }

    const waveResults = await Promise.all(
      wave.map(async (stepId) => {
        const step = byId.get(stepId);
        if (!step) {
          return {
            stepId,
            status: "failed" as const,
            execId: "unknown",
            threadId: "unknown",
            outputText: "",
            error: `Missing step: ${stepId}`,
          };
        }

        const depOutputs = getDeps(stepId).map((depId) => {
          const dep = results.get(depId);
          return dep
            ? { id: depId, status: dep.status, outputText: dep.outputText }
            : { id: depId, status: "failed" as const, outputText: "(missing)" };
        });

        const prompt = buildStepPrompt(options.task, step, depOutputs);
        try {
          const resolved = resolveStepCodexSettings({
            globalModel: options.model,
            globalEffort: options.effort,
            workflowDefaults: workflow.defaults,
            stepAdapterRequest: step.adapterRequest,
          });
          const run = await codexExec({
            label: `step:${stepId}`,
            prompt,
            model: resolved.model,
            effort: resolved.effort,
            unsafe: options.unsafe,
            search: options.search,
            captureContext,
          });
          return {
            stepId,
            status: "succeeded" as const,
            execId: run.execId,
            threadId: run.threadId,
            outputText: run.outputText,
            usage: run.usage,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (error instanceof CodexExecError) {
            return {
              stepId,
              status: "failed" as const,
              execId: error.execId,
              threadId: error.threadId,
              outputText: "",
              error: message,
            };
          }
          return {
            stepId,
            status: "failed" as const,
            execId: "unknown",
            threadId: "unknown",
            outputText: "",
            error: message,
          };
        }
      }),
    );

    for (const result of waveResults) {
      results.set(result.stepId, result);
      completed.add(result.stepId);
      remaining.delete(result.stepId);
      running.delete(result.stepId);
      console.log(
        `[step:${result.stepId}] ${result.status} thread=${result.threadId}${result.error ? ` error=${result.error}` : ""}`,
      );
    }
  }

  return workflow.steps.map((step) => {
    return (
      results.get(step.id) ?? {
        stepId: step.id,
        status: "failed",
        execId: "unknown",
        threadId: "unknown",
        outputText: "",
        error: "Missing step result.",
      }
    );
  });
}

function buildStepPrompt(
  task: string,
  step: WorkflowStep,
  deps: Array<{ id: string; status: StepResult["status"]; outputText: string }>,
): string {
  const blocks: string[] = [];
  blocks.push(step.goal.trim());
  blocks.push("");
  blocks.push(`Overall task: ${task}`);

  if (deps.length > 0) {
    blocks.push("");
    blocks.push("Dependency outputs (copy/paste; may be long):");
    for (const dep of deps) {
      blocks.push(`\n--- ${dep.id} (${dep.status}) ---\n`);
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

function resolveStepCodexSettings(params: {
  globalModel: string;
  globalEffort: ReasoningEffort;
  workflowDefaults?: Record<string, unknown>;
  stepAdapterRequest?: Record<string, unknown>;
}): { model: string; effort: ReasoningEffort } {
  const defaultsAdapterRequest = isPlainObject(params.workflowDefaults?.adapterRequest)
    ? (params.workflowDefaults?.adapterRequest as Record<string, unknown>)
    : undefined;

  const model =
    (typeof params.stepAdapterRequest?.model === "string" ? params.stepAdapterRequest.model : undefined) ??
    (typeof defaultsAdapterRequest?.model === "string" ? (defaultsAdapterRequest.model as string) : undefined) ??
    params.globalModel;

  const effortRaw =
    (typeof params.stepAdapterRequest?.modelReasoningEffort === "string"
      ? params.stepAdapterRequest.modelReasoningEffort
      : undefined) ??
    (typeof defaultsAdapterRequest?.modelReasoningEffort === "string"
      ? (defaultsAdapterRequest.modelReasoningEffort as string)
      : undefined);

  return {
    model,
    effort: parseEffort(effortRaw),
  };
}

async function checkCompletion(
  options: RunnerOptions,
  workflow: Workflow,
  results: StepResult[],
  iteration: number,
  captureContext: CaptureContext,
): Promise<{ completion: CompletionCheck; execId: string }> {
  const condensed = results.map((r) => ({
    stepId: r.stepId,
    status: r.status,
    threadId: r.threadId,
    output: truncate(r.outputText, 18_000),
    error: r.error,
  }));

  const promptParts: string[] = [];
  promptParts.push("use the reviewer skill.");
  promptParts.push("");
  promptParts.push(`Task: ${options.task}`);
  promptParts.push(`Iteration: ${iteration}`);
  promptParts.push("");
  promptParts.push("Here are the workflow results (JSON):");
  promptParts.push(JSON.stringify({ workflowId: workflow.id, results: condensed }, null, 2));
  promptParts.push("");
  promptParts.push("Return JSON ONLY with one of these shapes:");
  promptParts.push('1) {"done":true,"summary":"..."}');
  promptParts.push(
    '2) {"done":false,"reason":"...","nextWorkflow":{...workflow json...}}',
  );
  promptParts.push("");
  promptParts.push("Rules:");
  promptParts.push("- Be strict: done=true only if the task is actually completed.");
  promptParts.push("- If not done, provide a small nextWorkflow (<= 6 steps) that finishes the remaining work.");
  promptParts.push("- nextWorkflow steps should begin with: \"use the <skill> skill.\"");

  const run = await codexExec({
    label: `completion-check:iteration-${iteration}`,
    prompt: promptParts.join("\n"),
    model: options.model,
    effort: options.effort,
    unsafe: options.unsafe,
    search: options.search,
    captureContext,
  });

  const parsed = safeJsonParse(run.outputText);
  if (!parsed || typeof parsed !== "object") {
    return {
      completion: {
        done: false,
        reason: "Reviewer returned invalid JSON; stopping.",
      },
      execId: run.execId,
    };
  }
  const done = (parsed as { done?: unknown }).done;
  if (done === true) {
    const summary = String((parsed as { summary?: unknown }).summary ?? "").trim();
    return { completion: { done: true, summary: summary || "Done." }, execId: run.execId };
  }

  const reason = String((parsed as { reason?: unknown }).reason ?? "").trim() || "Not done.";
  const nextWorkflowRaw = (parsed as { nextWorkflow?: unknown }).nextWorkflow;
  if (nextWorkflowRaw) {
    try {
      const nextWorkflow = normalizeWorkflow(nextWorkflowRaw);
      return { completion: { done: false, reason, nextWorkflow }, execId: run.execId };
    } catch {
      return { completion: { done: false, reason }, execId: run.execId };
    }
  }
  return { completion: { done: false, reason }, execId: run.execId };
}

async function codexExec(params: {
  label: string;
  prompt: string;
  model: string;
  effort: ReasoningEffort;
  unsafe: boolean;
  search: boolean;
  resumeThreadId?: string;
  outputSchemaPath?: string;
  captureContext: CaptureContext;
}): Promise<CodexRunResult> {
  const execIndex = allocateExecIndex(params.captureContext);
  const execId = `exec-${String(execIndex).padStart(3, "0")}`;
  const safeLabel = slugifyLabel(params.label);
  const execDir = path.join(
    params.captureContext.runDir,
    `${execId}-${safeLabel}`,
  );
  await mkdir(execDir, { recursive: true });
  const eventsJsonlPath = path.join(execDir, "events.jsonl");
  const stderrPath = path.join(execDir, "stderr.txt");
  const lastMessagePath = path.join(execDir, "last_message.txt");
  const promptPath = path.join(execDir, "prompt.txt");
  const argvPath = path.join(execDir, "argv.json");
  const schemaPath = params.outputSchemaPath
    ? path.join(execDir, params.outputSchemaPath)
    : undefined;

  const args: string[] = ["exec"];
  if (params.resumeThreadId) {
    args.push("resume");
  }
  args.push("--json");
  args.push("--output-last-message", lastMessagePath);
  if (schemaPath) {
    args.push("--output-schema", schemaPath);
  }
  if (params.model) {
    args.push("-m", params.model);
  }
  args.push("-c", `model_reasoning_effort=${params.effort}`);
  if (params.search) {
    args.push("--search");
  }
  if (params.unsafe) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  if (params.resumeThreadId) {
    args.push(params.resumeThreadId);
  }
  args.push(params.prompt);

  await writeFile(promptPath, params.prompt, "utf8");
  await writeFile(argvPath, JSON.stringify(["codex", ...args], null, 2), "utf8");

  const startedAt = new Date().toISOString();
  const events: CodexEvent[] = [];
  let threadId = params.resumeThreadId ?? "";
  let outputTextFromStream = "";
  let usage: unknown = undefined;
  let fatalError = "";
  const stderrChunks: Buffer[] = [];

  const eventsStream = createWriteStream(eventsJsonlPath);
  const stderrStream = createWriteStream(stderrPath);

  let child: ReturnType<typeof spawn> | null = null;
  try {
    child = spawn("codex", args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    fatalError = error instanceof Error ? error.message : String(error);
    stderrStream.write(`Failed to spawn codex: ${fatalError}\n`);
  }

  const parseEvents = async (): Promise<void> => {
    if (!child?.stdout) {
      fatalError = fatalError || "Codex stdout unavailable.";
      return;
    }
    child.stdout.on("data", (chunk) => {
      eventsStream.write(chunk);
    });
    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let evt: CodexEvent;
      try {
        evt = JSON.parse(trimmed) as CodexEvent;
      } catch {
        fatalError = fatalError || `Failed to parse codex JSON event: ${trimmed}`;
        continue;
      }
      events.push(evt);

      if (evt.type === "thread.started" && typeof evt.thread_id === "string") {
        threadId = evt.thread_id;
        continue;
      }
      if (evt.type === "item.completed") {
        const item = (evt as { item?: unknown }).item as { type?: unknown; text?: unknown } | undefined;
        if (item && item.type === "agent_message" && typeof item.text === "string") {
          outputTextFromStream = item.text;
        }
        continue;
      }
      if (evt.type === "turn.completed") {
        usage = (evt as { usage?: unknown }).usage;
        continue;
      }
      if (evt.type === "turn.failed") {
        const error = (evt as { error?: unknown }).error;
        fatalError = typeof error === "string" ? error : "Codex turn failed.";
        continue;
      }
      if (evt.type === "error") {
        const message = (evt as { message?: unknown }).message;
        fatalError = typeof message === "string" ? message : "Codex error.";
        continue;
      }
    }
  };

  const readStderr = (): void => {
    if (!child?.stderr) {
      return;
    }
    child.stderr.on("data", (chunk) => {
      const buffer = Buffer.from(chunk);
      stderrChunks.push(buffer);
      stderrStream.write(buffer);
    });
  };

  let exitCode = 1;
  if (child) {
    readStderr();
    const exitPromise = new Promise<number>((resolve) => {
      child.once("exit", (code) => resolve(code ?? 1));
      child.once("error", (error) => {
        fatalError = error instanceof Error ? error.message : String(error);
        stderrStream.write(`Codex process error: ${fatalError}\n`);
        resolve(1);
      });
    });
    const [, code] = await Promise.all([parseEvents(), exitPromise]);
    exitCode = code;
  }

  await new Promise<void>((resolve) => eventsStream.end(resolve));
  await new Promise<void>((resolve) => stderrStream.end(resolve));

  let outputText = outputTextFromStream;
  try {
    outputText = await readFile(lastMessagePath, "utf8");
  } catch {
    // Ignore missing output-last-message file.
  }

  const finishedAt = new Date().toISOString();
  const execEntry: ExecManifestEntry = {
    execId,
    label: params.label,
    threadId: threadId || "unknown",
    status: exitCode === 0 && !fatalError ? "succeeded" : "failed",
    exitCode,
    startedAt,
    finishedAt,
    artifacts: {
      eventsJsonl: path.relative(params.captureContext.runDir, eventsJsonlPath),
      stderrTxt: path.relative(params.captureContext.runDir, stderrPath),
      lastMessageTxt: path.relative(params.captureContext.runDir, lastMessagePath),
      promptTxt: path.relative(params.captureContext.runDir, promptPath),
      argvJson: path.relative(params.captureContext.runDir, argvPath),
      schemaJson: schemaPath
        ? path.relative(params.captureContext.runDir, schemaPath)
        : undefined,
    },
  };
  params.captureContext.runManifest.execs.push(execEntry);
  recordExecGraphNode(execEntry, params.captureContext);
  if (params.resumeThreadId) {
    recordResumeEdge(params.resumeThreadId, execEntry, params.captureContext);
  }
  if (threadId) {
    await enrichGraphFromTranscript(threadId, params.captureContext);
  }
  await writeManifest(params.captureContext);

  if (fatalError) {
    throw new CodexExecError(fatalError, {
      execId,
      threadId: threadId || "unknown",
      exitCode,
    });
  }
  if (exitCode !== 0) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    throw new CodexExecError(stderr || `codex exited with code ${exitCode}`, {
      execId,
      threadId: threadId || "unknown",
      exitCode,
    });
  }
  if (!threadId) {
    throw new CodexExecError("codex did not emit thread.started", {
      execId,
      threadId: threadId || "unknown",
      exitCode,
    });
  }
  return { execId, threadId, outputText, events, usage };
}

function allocateExecIndex(captureContext: CaptureContext): number {
  const index = captureContext.nextExecIndex;
  captureContext.nextExecIndex += 1;
  return index;
}

async function writeManifest(captureContext: CaptureContext): Promise<void> {
  syncGraphToManifest(captureContext);
  captureContext.manifestWrite = captureContext.manifestWrite.then(() =>
    writeFile(
      captureContext.runManifestPath,
      JSON.stringify(captureContext.runManifest, null, 2),
      "utf8",
    ),
  );
  await captureContext.manifestWrite;
}

function recordExecGraphNode(entry: ExecManifestEntry, captureContext: CaptureContext): void {
  const nodeId = `exec:${entry.execId}`;
  if (!captureContext.graphIndex.nodes.has(nodeId)) {
    captureContext.graphIndex.nodes.set(nodeId, {
      id: nodeId,
      type: "exec",
      execId: entry.execId,
      label: entry.label,
      threadId: entry.threadId,
      artifacts: entry.artifacts,
    });
  }
  const threadNodes = captureContext.graphIndex.threadToExecNodes.get(entry.threadId) ?? [];
  if (!threadNodes.includes(nodeId)) {
    threadNodes.push(nodeId);
    captureContext.graphIndex.threadToExecNodes.set(entry.threadId, threadNodes);
  }
}

function ensureThreadNode(threadId: string, captureContext: CaptureContext): string {
  const nodeId = `thread:${threadId}`;
  if (!captureContext.graphIndex.nodes.has(nodeId)) {
    captureContext.graphIndex.nodes.set(nodeId, { id: nodeId, type: "thread", threadId });
  }
  return nodeId;
}

function nodeIdForThread(threadId: string, captureContext: CaptureContext): string {
  const execNodes = captureContext.graphIndex.threadToExecNodes.get(threadId) ?? [];
  if (execNodes.length === 1) {
    return execNodes[0];
  }
  return ensureThreadNode(threadId, captureContext);
}

function recordGraphEdge(
  edge: GraphEdge,
  captureContext: CaptureContext,
  dedupeKey?: string,
): void {
  const key =
    dedupeKey ??
    [
      edge.type,
      edge.from,
      edge.to,
      edge.callId ?? "",
      edge.status ?? "",
      edge.prompt ?? "",
    ].join("|");
  if (!captureContext.graphIndex.edges.has(key)) {
    captureContext.graphIndex.edges.set(key, edge);
  }
}

function recordWarning(message: string, captureContext: CaptureContext): void {
  captureContext.graphIndex.warnings.add(message);
}

function syncGraphToManifest(captureContext: CaptureContext): void {
  captureContext.runManifest.graph = {
    nodes: Array.from(captureContext.graphIndex.nodes.values()),
    edges: Array.from(captureContext.graphIndex.edges.values()),
    warnings: Array.from(captureContext.graphIndex.warnings.values()),
  };
}

function recordWorkflowDependsOnEdges(
  workflow: Workflow,
  results: StepResult[],
  captureContext: CaptureContext,
): void {
  const execByStep = new Map<string, string>();
  for (const result of results) {
    if (result.execId && result.execId !== "unknown") {
      execByStep.set(result.stepId, `exec:${result.execId}`);
    }
  }
  for (const step of workflow.steps) {
    const stepNode = execByStep.get(step.id);
    if (!stepNode || !Array.isArray(step.dependsOn)) {
      continue;
    }
    for (const dep of step.dependsOn) {
      const depNode = execByStep.get(dep);
      if (!depNode) continue;
      recordGraphEdge(
        {
          type: "dependsOn",
          from: depNode,
          to: stepNode,
          source: "workflow",
        },
        captureContext,
      );
    }
  }
}

function recordInvokesEdges(
  workflowGenExecId: string | null,
  stepResults: StepResult[],
  completionExecId: string | null,
  captureContext: CaptureContext,
): void {
  if (workflowGenExecId) {
    const workflowNode = `exec:${workflowGenExecId}`;
    for (const step of stepResults) {
      if (!step.execId || step.execId === "unknown") continue;
      recordGraphEdge(
        {
          type: "invokes",
          from: workflowNode,
          to: `exec:${step.execId}`,
          source: "workflow",
        },
        captureContext,
      );
    }
  }
  if (completionExecId) {
    const completionNode = `exec:${completionExecId}`;
    for (const step of stepResults) {
      if (!step.execId || step.execId === "unknown") continue;
      recordGraphEdge(
        {
          type: "invokes",
          from: `exec:${step.execId}`,
          to: completionNode,
          source: "workflow",
        },
        captureContext,
      );
    }
  }
}

function recordCompletionToWorkflowEdge(
  completionExecId: string,
  workflowGenExecId: string,
  captureContext: CaptureContext,
): void {
  recordGraphEdge(
    {
      type: "invokes",
      from: `exec:${completionExecId}`,
      to: `exec:${workflowGenExecId}`,
      source: "workflow",
    },
    captureContext,
  );
}

function recordResumeEdge(
  resumeThreadId: string,
  execEntry: ExecManifestEntry,
  captureContext: CaptureContext,
): void {
  const fromNode = ensureThreadNode(resumeThreadId, captureContext);
  const toNode = `exec:${execEntry.execId}`;
  recordGraphEdge(
    {
      type: "resume",
      from: fromNode,
      to: toNode,
      source: "resume",
    },
    captureContext,
  );
}

async function enrichGraphFromTranscript(
  threadId: string,
  captureContext: CaptureContext,
): Promise<void> {
  if (captureContext.graphIndex.transcriptThreads.has(threadId)) {
    return;
  }
  captureContext.graphIndex.transcriptThreads.add(threadId);

  let transcriptPath: string | null = null;
  try {
    transcriptPath = await findTranscriptPath(threadId);
  } catch (error) {
    recordWarning(
      `Failed to scan transcripts for threadId=${threadId}: ${error instanceof Error ? error.message : String(error)}`,
      captureContext,
    );
    return;
  }

  if (!transcriptPath) {
    recordWarning(`Transcript not found for threadId=${threadId}`, captureContext);
    return;
  }

  try {
    await parseTranscript(transcriptPath, captureContext);
  } catch (error) {
    recordWarning(
      `Failed to parse transcript for threadId=${threadId}: ${error instanceof Error ? error.message : String(error)}`,
      captureContext,
    );
  }
}

async function findTranscriptPath(threadId: string): Promise<string | null> {
  const sessionsDir = path.join(os.homedir(), ".codex", "sessions");
  let entries: Array<{ filePath: string; mtimeMs: number }> = [];

  const walk = async (dir: string): Promise<void> => {
    let dirEntries: Array<import("node:fs").Dirent>;
    try {
      dirEntries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      dirEntries.map(async (entry) => {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(entryPath);
          return;
        }
        if (!entry.isFile()) return;
        if (!entry.name.includes(`-${threadId}.jsonl`)) return;
        if (!entry.name.startsWith("rollout-")) return;
        try {
          const stats = await stat(entryPath);
          entries.push({ filePath: entryPath, mtimeMs: stats.mtimeMs });
        } catch {
          // ignore stat errors
        }
      }),
    );
  };

  await walk(sessionsDir);
  if (entries.length === 0) {
    return null;
  }
  entries = entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries[0].filePath;
}

async function parseTranscript(
  transcriptPath: string,
  captureContext: CaptureContext,
): Promise<void> {
  const stream = createReadStream(transcriptPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!payload || typeof payload !== "object") continue;
    const record = payload as { type?: unknown; payload?: unknown };
    if (record.type !== "event_msg" || !record.payload || typeof record.payload !== "object") {
      continue;
    }
    const evt = record.payload as Record<string, unknown>;
    const evtType = typeof evt.type === "string" ? evt.type : "";
    if (
      evtType !== "collab_agent_spawn_begin" &&
      evtType !== "collab_agent_spawn_end" &&
      evtType !== "collab_agent_interaction_begin" &&
      evtType !== "collab_agent_interaction_end"
    ) {
      continue;
    }

    const senderThreadId = typeof evt.sender_thread_id === "string" ? evt.sender_thread_id : "";
    const newThreadId = typeof evt.new_thread_id === "string" ? evt.new_thread_id : "";
    const receiverThreadId =
      typeof evt.receiver_thread_id === "string" ? evt.receiver_thread_id : "";
    const callId = typeof evt.call_id === "string" ? evt.call_id : undefined;
    const prompt = typeof evt.prompt === "string" ? evt.prompt : undefined;
    const status =
      typeof evt.status === "string"
        ? evt.status
        : evtType.endsWith("_begin")
          ? "begin"
          : "end";

    const targetThreadId = newThreadId || receiverThreadId;
    if (!senderThreadId || !targetThreadId) continue;

    const edgeType = evtType.includes("spawn") ? "spawn" : "interact";
    const fromNode = ensureThreadNode(senderThreadId, captureContext);
    const toNode = ensureThreadNode(targetThreadId, captureContext);
    const callSignature = [edgeType, senderThreadId, targetThreadId, status ?? ""].join("|");
    if (callId) {
      const prior = captureContext.graphIndex.transcriptCallIds.get(callId);
      if (prior && prior !== callSignature) {
        recordWarning(
          `Transcript call_id collision for call_id=${callId} (saw ${prior} and ${callSignature})`,
          captureContext,
        );
      } else if (!prior) {
        captureContext.graphIndex.transcriptCallIds.set(callId, callSignature);
      }
    }

    const transcriptKey = [edgeType, senderThreadId, targetThreadId, callId ?? "", status ?? ""].join(
      "|",
    );
    recordGraphEdge(
      {
        type: edgeType,
        from: fromNode,
        to: toNode,
        callId,
        status,
        prompt,
        source: "transcript",
      },
      captureContext,
      `transcript|${transcriptKey}`,
    );
  }
}

function parseWorkflowJson(text: string): Workflow {
  const parsed = safeJsonParse(text);
  if (!parsed) {
    throw new Error("Workflow generator returned invalid JSON.");
  }
  return normalizeWorkflow(parsed);
}

function normalizeWorkflow(value: unknown): Workflow {
  if (!value || typeof value !== "object") {
    throw new Error("Workflow must be an object.");
  }
  const obj = value as Record<string, unknown>;
  const version = obj.version;
  const id = obj.id;
  const steps = obj.steps;
  if (version !== 1) {
    throw new Error("Workflow.version must be 1.");
  }
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("Workflow.id must be a non-empty string.");
  }
  if (!Array.isArray(steps)) {
    throw new Error("Workflow.steps must be an array.");
  }
  const normalizedSteps: WorkflowStep[] = steps.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`Step ${index + 1} must be an object.`);
    }
    const step = raw as Record<string, unknown>;
    const stepId = typeof step.id === "string" && step.id.trim() ? step.id.trim() : `step-${index + 1}`;
    const type = step.type;
    if (type !== "agent.run") {
      throw new Error(`Step "${stepId}" has unsupported type "${String(type)}".`);
    }
    const goal = typeof step.goal === "string" ? step.goal : "";
    if (!goal.trim()) {
      throw new Error(`Step "${stepId}" is missing goal.`);
    }
    const dependsOn = Array.isArray(step.dependsOn)
      ? step.dependsOn.map((dep) => String(dep).trim()).filter(Boolean)
      : undefined;
    const context = typeof step.context === "string" ? step.context : undefined;
    const adapterRequest = isPlainObject(step.adapterRequest)
      ? (step.adapterRequest as Record<string, unknown>)
      : undefined;
    return {
      ...step,
      id: stepId,
      type: "agent.run",
      goal,
      dependsOn,
      context,
      adapterRequest,
    };
  });

  const concurrency = obj.concurrency;
  return {
    version: 1,
    id: id.trim(),
    name: typeof obj.name === "string" ? obj.name : undefined,
    description: typeof obj.description === "string" ? obj.description : undefined,
    defaults: typeof obj.defaults === "object" && obj.defaults !== null ? (obj.defaults as Record<string, unknown>) : undefined,
    concurrency: typeof concurrency === "number" && Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : undefined,
    steps: normalizedSteps,
  };
}

function safeJsonParse(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Best-effort JSON extraction (handles accidental leading/trailing prose).
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      return null;
    }
    const slice = trimmed.slice(start, end + 1);
    try {
      return JSON.parse(slice) as unknown;
    } catch {
      return null;
    }
  }
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.7));
  const tail = text.slice(-Math.floor(maxChars * 0.3));
  return `${head}\n\n…(truncated ${text.length - maxChars} chars)…\n\n${tail}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function slugifyLabel(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "exec";
}

function formatCarrySummary(
  workflow: Workflow,
  results: StepResult[],
  completion: CompletionCheck,
): string {
  const lines: string[] = [];
  lines.push(`Previous workflow: ${workflow.id}`);
  lines.push("Step statuses:");
  for (const r of results) {
    lines.push(`- ${r.stepId}: ${r.status} (thread ${r.threadId})`);
    if (r.error) {
      lines.push(`  error: ${r.error}`);
    }
  }
  if (!completion.done) {
    lines.push(`Reviewer: not done (${completion.reason})`);
  }
  return lines.join("\n");
}

function parseArgs(argv: string[]): RunnerOptions | null {
  let model = DEFAULT_MODEL;
  let effort: ReasoningEffort = DEFAULT_EFFORT;
  let concurrency = 3;
  let maxIterations = 4;
  let unsafe = false;
  let search = false;
  let outDir = "runs/autopilot";
  const taskParts: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--model") {
      model = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
      continue;
    }
    if (arg === "--effort") {
      effort = parseEffort(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("--effort=")) {
      effort = parseEffort(arg.slice("--effort=".length));
      continue;
    }
    if (arg === "--concurrency") {
      concurrency = Number.parseInt(String(argv[i + 1] ?? ""), 10);
      i += 1;
      continue;
    }
    if (arg.startsWith("--concurrency=")) {
      concurrency = Number.parseInt(arg.slice("--concurrency=".length), 10);
      continue;
    }
    if (arg === "--max-iterations") {
      maxIterations = Number.parseInt(String(argv[i + 1] ?? ""), 10);
      i += 1;
      continue;
    }
    if (arg.startsWith("--max-iterations=")) {
      maxIterations = Number.parseInt(arg.slice("--max-iterations=".length), 10);
      continue;
    }
    if (arg === "--unsafe") {
      unsafe = true;
      continue;
    }
    if (arg === "--search") {
      search = true;
      continue;
    }
    if (arg === "--out-dir") {
      outDir = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg.startsWith("--out-dir=")) {
      outDir = arg.slice("--out-dir=".length);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return null;
    }
    taskParts.push(arg);
  }

  const task = taskParts.join(" ").trim();
  if (!task) {
    return null;
  }
  const resolvedConcurrency = Number.isFinite(concurrency) ? Math.max(1, concurrency) : 3;
  const resolvedMaxIterations = Number.isFinite(maxIterations) ? Math.max(1, maxIterations) : 4;
  return {
    task,
    model: model || DEFAULT_MODEL,
    effort,
    concurrency: resolvedConcurrency,
    maxIterations: resolvedMaxIterations,
    unsafe,
    search,
    outDir: outDir || "runs/autopilot",
  };
}

function parseEffort(value: unknown): ReasoningEffort {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh"
  ) {
    return normalized;
  }
  return DEFAULT_EFFORT;
}

function printHelp(): void {
  console.log(
    [
      "Usage:",
      "  node --import tsx examples/codex-autopilot.ts [options] \"<task>\"",
      "",
      "Options:",
      `  --model <model>           (default: ${DEFAULT_MODEL})`,
      `  --effort <level>          minimal|low|medium|high|xhigh (default: ${DEFAULT_EFFORT})`,
      "  --concurrency <n>         Max parallel steps (default: 3)",
      "  --max-iterations <n>      Plan/execute cycles (default: 4)",
      "  --search                  Enable live web search in Codex",
      "  --unsafe                  Disable approvals/sandbox (dangerous)",
      "  --out-dir <dir>           Write run JSON here (default: runs/autopilot)",
      "",
      "Example:",
      "  node --import tsx examples/codex-autopilot.ts --effort=high \"Refactor multiAgent.ts to be more declarative\"",
    ].join("\n"),
  );
}
