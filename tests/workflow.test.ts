import { describe, it } from "node:test";
import assert from "node:assert";
import { parseWorkflow } from "../src/workflow/parser.js";

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
