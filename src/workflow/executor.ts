/**
 * Workflow execution utilities.
 */

import type { WorkflowStep, StepResult } from "./types.js";

/**
 * Resolve workflow steps into execution waves (parallel groups).
 * Throws if circular dependencies are detected.
 */
export function resolveDependencyOrder(steps: WorkflowStep[]): WorkflowStep[][] {
  const cycle = detectCycle(steps);
  if (cycle) {
    throw new Error(`Circular dependency detected: ${cycle.join(" → ")}`);
  }

  const completed = new Set<string>();
  const waves: WorkflowStep[][] = [];

  while (completed.size < steps.length) {
    const ready = steps.filter(
      (step) =>
        !completed.has(step.id) &&
        (step.dependsOn ?? []).every((dep) => completed.has(dep))
    );

    if (ready.length === 0) {
      const remaining = steps
        .filter((s) => !completed.has(s.id))
        .map((s) => s.id);
      throw new Error(`Workflow stuck: cannot resolve ${remaining.join(", ")}`);
    }

    waves.push(ready);
    for (const step of ready) {
      completed.add(step.id);
    }
  }

  return waves;
}

/**
 * Detect circular dependencies in workflow steps.
 * Returns the cycle path if found, null otherwise.
 */
export function detectCycle(steps: WorkflowStep[]): string[] | null {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const path: string[] = [];

  function dfs(id: string): string[] | null {
    if (inStack.has(id)) {
      const cycleStart = path.indexOf(id);
      return [...path.slice(cycleStart), id];
    }
    if (visited.has(id)) {
      return null;
    }

    visited.add(id);
    inStack.add(id);
    path.push(id);

    const step = byId.get(id);
    if (step) {
      for (const dep of step.dependsOn ?? []) {
        const cycle = dfs(dep);
        if (cycle) return cycle;
      }
    }

    path.pop();
    inStack.delete(id);
    return null;
  }

  for (const step of steps) {
    const cycle = dfs(step.id);
    if (cycle) return cycle;
  }

  return null;
}

/**
 * Find steps that are ready to execute (all deps satisfied).
 */
export function findReadySteps(
  steps: WorkflowStep[],
  completed: Set<string>,
  running: Set<string>
): WorkflowStep[] {
  return steps.filter(
    (step) =>
      !completed.has(step.id) &&
      !running.has(step.id) &&
      (step.dependsOn ?? []).every((dep) => completed.has(dep))
  );
}
