/**
 * Parse and validate workflow JSON from LLM output.
 */

import type { Workflow, WorkflowStep } from "./types.js";
import { safeJsonParse } from "../utils/json.js";

export class WorkflowParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowParseError";
  }
}

/**
 * Parse workflow JSON from text, extracting from prose if needed.
 */
export function parseWorkflow(text: string): Workflow {
  const parsed = safeJsonParse(text);
  if (!parsed) {
    throw new WorkflowParseError("Invalid JSON: could not parse workflow");
  }
  return normalizeWorkflow(parsed);
}

/**
 * Validate and normalize a parsed workflow object.
 */
export function normalizeWorkflow(value: unknown): Workflow {
  if (!value || typeof value !== "object") {
    throw new WorkflowParseError("Workflow must be an object");
  }

  const obj = value as Record<string, unknown>;

  if (obj.version !== 1) {
    throw new WorkflowParseError("Workflow.version must be 1");
  }

  if (typeof obj.id !== "string" || !obj.id.trim()) {
    throw new WorkflowParseError("Workflow.id must be a non-empty string");
  }

  if (!Array.isArray(obj.steps)) {
    throw new WorkflowParseError("Workflow.steps must be an array");
  }

  const steps = obj.steps.map((raw, index) => normalizeStep(raw, index));

  return {
    version: 1,
    id: obj.id.trim(),
    name: typeof obj.name === "string" ? obj.name : undefined,
    description: typeof obj.description === "string" ? obj.description : undefined,
    concurrency:
      typeof obj.concurrency === "number" && Number.isFinite(obj.concurrency)
        ? Math.max(1, Math.floor(obj.concurrency))
        : undefined,
    defaults:
      typeof obj.defaults === "object" && obj.defaults !== null
        ? (obj.defaults as Record<string, unknown>)
        : undefined,
    steps,
  };
}

function normalizeStep(raw: unknown, index: number): WorkflowStep {
  if (!raw || typeof raw !== "object") {
    throw new WorkflowParseError(`Step ${index + 1} must be an object`);
  }

  const step = raw as Record<string, unknown>;
  const id =
    typeof step.id === "string" && step.id.trim()
      ? step.id.trim()
      : `step-${index + 1}`;

  if (step.type !== "agent.run") {
    throw new WorkflowParseError(
      `Step "${id}" has unsupported type "${String(step.type)}"`
    );
  }

  const goal = typeof step.goal === "string" ? step.goal : "";
  if (!goal.trim()) {
    throw new WorkflowParseError(`Step "${id}" is missing goal`);
  }

  const dependsOn = Array.isArray(step.dependsOn)
    ? step.dependsOn.map((dep) => String(dep).trim()).filter(Boolean)
    : undefined;

  return {
    ...step,
    id,
    type: "agent.run",
    goal,
    dependsOn,
    context: typeof step.context === "string" ? step.context : undefined,
    adapterRequest:
      typeof step.adapterRequest === "object" && step.adapterRequest !== null
        ? (step.adapterRequest as Record<string, unknown>)
        : undefined,
  };
}
