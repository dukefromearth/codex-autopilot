import { describe, it } from "node:test";
import assert from "node:assert";
import { run } from "../src/runner.js";
import { MockAdapter } from "../src/adapters/mock.js";
import { rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("Integration: run() with MockAdapter", () => {
  it("completes a single-iteration workflow", async () => {
    const outDir = path.join(os.tmpdir(), `autopilot-test-${Date.now()}`);

    const adapter = new MockAdapter([
      // Workflow generation
      {
        sessionId: "wf-gen-1",
        outputText: JSON.stringify({
          version: 1,
          id: "test-workflow",
          steps: [{ id: "impl", type: "agent.run", goal: "implement feature" }],
        }),
        status: "succeeded",
      },
      // Step execution
      {
        sessionId: "step-impl",
        outputText: "Done: implemented the feature.",
        status: "succeeded",
      },
      // Completion check
      {
        sessionId: "completion-1",
        outputText: JSON.stringify({ done: true, summary: "All complete!" }),
        status: "succeeded",
      },
    ]);

    const result = await run({
      task: "Test task",
      adapter,
      options: {
        adapter: "claude",
        model: "test-model",
        concurrency: 1,
        maxIterations: 2,
        unsafe: false,
      },
      outDir,
    });

    assert.strictEqual(result.status, "completed");
    assert.strictEqual(result.summary, "All complete!");

    // Verify manifest was created
    const manifestPath = path.join(outDir, result.runId, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.strictEqual(manifest.execs.length, 3); // wf-gen, step, completion

    // Cleanup
    await rm(outDir, { recursive: true, force: true });
  });

  it("handles multi-iteration workflow", async () => {
    const outDir = path.join(os.tmpdir(), `autopilot-test-${Date.now()}`);

    const adapter = new MockAdapter([
      // Iteration 1: workflow gen
      {
        sessionId: "wf-1",
        outputText: JSON.stringify({
          version: 1,
          id: "wf-1",
          steps: [{ id: "s1", type: "agent.run", goal: "step 1" }],
        }),
        status: "succeeded",
      },
      // Iteration 1: step
      { sessionId: "s1", outputText: "Step 1 done", status: "succeeded" },
      // Iteration 1: completion (not done)
      {
        sessionId: "c1",
        outputText: JSON.stringify({
          done: false,
          reason: "Need more work",
          nextWorkflow: {
            version: 1,
            id: "wf-2",
            steps: [{ id: "s2", type: "agent.run", goal: "step 2" }],
          },
        }),
        status: "succeeded",
      },
      // Iteration 2: step (using nextWorkflow)
      { sessionId: "s2", outputText: "Step 2 done", status: "succeeded" },
      // Iteration 2: completion (done)
      {
        sessionId: "c2",
        outputText: JSON.stringify({ done: true, summary: "Finally done" }),
        status: "succeeded",
      },
    ]);

    const result = await run({
      task: "Multi-iteration task",
      adapter,
      options: {
        adapter: "claude",
        model: "test",
        concurrency: 1,
        maxIterations: 3,
        unsafe: false,
      },
      outDir,
    });

    assert.strictEqual(result.status, "completed");

    // Cleanup
    await rm(outDir, { recursive: true, force: true });
  });
});
