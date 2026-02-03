import { describe, it } from "node:test";
import assert from "node:assert";
import { MockAdapter } from "../src/adapters/mock.js";

describe("MockAdapter", () => {
  it("returns predefined responses in order", async () => {
    const adapter = new MockAdapter([
      { sessionId: "s1", outputText: "first", status: "succeeded" },
      { sessionId: "s2", outputText: "second", status: "succeeded" },
    ]);

    const r1 = await adapter.execute({ prompt: "p1", cwd: "/" });
    const r2 = await adapter.execute({ prompt: "p2", cwd: "/" });

    assert.strictEqual(r1.outputText, "first");
    assert.strictEqual(r2.outputText, "second");
  });

  it("records all calls", async () => {
    const adapter = new MockAdapter([
      { sessionId: "s", outputText: "out", status: "succeeded" },
    ]);

    await adapter.execute({ prompt: "test prompt", cwd: "/test" });

    assert.strictEqual(adapter.calls.length, 1);
    assert.strictEqual(adapter.calls[0].prompt, "test prompt");
    assert.strictEqual(adapter.calls[0].cwd, "/test");
  });

  it("implements AgentAdapter interface", async () => {
    const adapter = new MockAdapter([
      { sessionId: "s", outputText: "out", status: "succeeded" },
    ]);

    // Verify interface
    assert.strictEqual(adapter.name, "claude");
    assert.strictEqual(typeof adapter.execute, "function");
    assert.strictEqual(typeof adapter.resume, "function");
  });
});
