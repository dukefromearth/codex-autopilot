import { describe, it } from "node:test";
import assert from "node:assert";
import { parseWorkflow } from "../src/workflow/parser.js";
import { buildStepPrompt, buildWorkflowGenPrompt, buildCompletionCheckPrompt } from "../src/workflow/prompt.js";
import { resolveDependencyOrder, detectCycle } from "../src/workflow/executor.js";
import type { StepResult } from "../src/workflow/types.js";

describe("parseWorkflow", () => {
  it("parses valid workflow JSON", () => {
    const input = JSON.stringify({
      version: 1,
      id: "test-workflow",
      steps: [
        { id: "step1", type: "agent.run", goal: "do something" },
      ],
    });
    const workflow = parseWorkflow(input);
    assert.strictEqual(workflow.id, "test-workflow");
    assert.strictEqual(workflow.steps.length, 1);
    assert.strictEqual(workflow.steps[0].id, "step1");
  });

  it("extracts JSON from prose-wrapped output", () => {
    const input = `Here's the workflow:
{"version":1,"id":"extracted","steps":[{"id":"a","type":"agent.run","goal":"test"}]}
Let me know if you need changes.`;
    const workflow = parseWorkflow(input);
    assert.strictEqual(workflow.id, "extracted");
  });

  it("throws on invalid JSON", () => {
    assert.throws(() => parseWorkflow("not json"), /invalid json/i);
  });

  it("throws on missing version", () => {
    const input = JSON.stringify({ id: "no-version", steps: [] });
    assert.throws(() => parseWorkflow(input), /version must be 1/i);
  });

  it("throws on missing steps", () => {
    const input = JSON.stringify({ version: 1, id: "no-steps" });
    assert.throws(() => parseWorkflow(input), /steps must be an array/i);
  });

  it("throws on step without goal", () => {
    const input = JSON.stringify({
      version: 1,
      id: "bad-step",
      steps: [{ id: "s1", type: "agent.run" }],
    });
    assert.throws(() => parseWorkflow(input), /missing goal/i);
  });

  it("normalizes step IDs when missing", () => {
    const input = JSON.stringify({
      version: 1,
      id: "auto-ids",
      steps: [
        { type: "agent.run", goal: "first" },
        { type: "agent.run", goal: "second" },
      ],
    });
    const workflow = parseWorkflow(input);
    assert.strictEqual(workflow.steps[0].id, "step-1");
    assert.strictEqual(workflow.steps[1].id, "step-2");
  });
});

describe("buildStepPrompt", () => {
  it("includes step goal and task", () => {
    const prompt = buildStepPrompt(
      { id: "impl", type: "agent.run", goal: "use the task-executor skill. Fix the bug." },
      new Map(),
      "Fix authentication bug"
    );
    assert.ok(prompt.includes("use the task-executor skill. Fix the bug."));
    assert.ok(prompt.includes("Overall task: Fix authentication bug"));
  });

  it("includes dependency outputs", () => {
    const completed = new Map<string, StepResult>([
      ["research", {
        stepId: "research",
        status: "succeeded",
        sessionId: "sess-1",
        outputText: "Found the issue in auth.ts line 42",
      }],
    ]);
    const prompt = buildStepPrompt(
      { id: "impl", type: "agent.run", goal: "implement fix", dependsOn: ["research"] },
      completed,
      "Fix bug"
    );
    assert.ok(prompt.includes("--- research (succeeded) ---"));
    assert.ok(prompt.includes("Found the issue in auth.ts line 42"));
  });

  it("handles empty dependency output", () => {
    const completed = new Map<string, StepResult>([
      ["empty", { stepId: "empty", status: "succeeded", sessionId: "s", outputText: "" }],
    ]);
    const prompt = buildStepPrompt(
      { id: "next", type: "agent.run", goal: "continue", dependsOn: ["empty"] },
      completed,
      "task"
    );
    assert.ok(prompt.includes("(empty)"));
  });
});

describe("buildWorkflowGenPrompt", () => {
  it("includes task and iteration", () => {
    const prompt = buildWorkflowGenPrompt("Build a feature", 1, "");
    assert.ok(prompt.includes("use the workflow-generator skill"));
    assert.ok(prompt.includes("Task: Build a feature"));
    assert.ok(prompt.includes("Iteration: 1"));
  });

  it("includes carry summary when provided", () => {
    const prompt = buildWorkflowGenPrompt("task", 2, "Previous: step1 failed");
    assert.ok(prompt.includes("Context from previous iterations:"));
    assert.ok(prompt.includes("Previous: step1 failed"));
  });
});

describe("resolveDependencyOrder", () => {
  it("returns steps with no deps first", () => {
    const steps = [
      { id: "b", type: "agent.run" as const, goal: "b", dependsOn: ["a"] },
      { id: "a", type: "agent.run" as const, goal: "a" },
    ];
    const waves = resolveDependencyOrder(steps);
    assert.strictEqual(waves[0][0].id, "a");
    assert.strictEqual(waves[1][0].id, "b");
  });

  it("groups parallel steps in same wave", () => {
    const steps = [
      { id: "a", type: "agent.run" as const, goal: "a" },
      { id: "b", type: "agent.run" as const, goal: "b" },
      { id: "c", type: "agent.run" as const, goal: "c", dependsOn: ["a", "b"] },
    ];
    const waves = resolveDependencyOrder(steps);
    assert.strictEqual(waves[0].length, 2); // a and b parallel
    assert.strictEqual(waves[1].length, 1); // c after
  });

  it("throws on circular dependency", () => {
    const steps = [
      { id: "a", type: "agent.run" as const, goal: "a", dependsOn: ["b"] },
      { id: "b", type: "agent.run" as const, goal: "b", dependsOn: ["a"] },
    ];
    assert.throws(() => resolveDependencyOrder(steps), /circular/i);
  });
});

describe("detectCycle", () => {
  it("returns null for valid DAG", () => {
    const steps = [
      { id: "a", type: "agent.run" as const, goal: "a" },
      { id: "b", type: "agent.run" as const, goal: "b", dependsOn: ["a"] },
    ];
    assert.strictEqual(detectCycle(steps), null);
  });

  it("returns cycle path for circular deps", () => {
    const steps = [
      { id: "a", type: "agent.run" as const, goal: "a", dependsOn: ["c"] },
      { id: "b", type: "agent.run" as const, goal: "b", dependsOn: ["a"] },
      { id: "c", type: "agent.run" as const, goal: "c", dependsOn: ["b"] },
    ];
    const cycle = detectCycle(steps);
    assert.ok(cycle !== null);
    assert.ok(cycle.length >= 2);
  });
});
