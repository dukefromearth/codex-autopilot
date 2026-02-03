/**
 * Run manifest management.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunManifest, RunContext, RunOptions, ExecEntry, GraphNode, GraphEdge } from "./types.js";

/**
 * Initialize a new run context.
 */
export async function initializeRun(
  task: string,
  options: RunOptions,
  outDir: string
): Promise<{ context: RunContext; manifest: RunManifest }> {
  const runId = `autopilot-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const runDir = path.join(outDir, runId);
  await mkdir(runDir, { recursive: true });

  const manifest: RunManifest = {
    runId,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
    options,
    execs: [],
    graph: {
      nodes: [],
      edges: [],
      warnings: [],
    },
  };

  const context: RunContext = {
    runId,
    runDir,
    task,
    cwd: process.cwd(),
    options,
    nextExecIndex: 1,
  };

  await writeManifest(context, manifest);

  return { context, manifest };
}

/**
 * Write manifest to disk.
 */
export async function writeManifest(
  context: RunContext,
  manifest: RunManifest
): Promise<void> {
  const manifestPath = path.join(context.runDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

/**
 * Add an exec entry to the manifest.
 */
export function addExecToManifest(
  manifest: RunManifest,
  entry: ExecEntry
): void {
  manifest.execs.push(entry);

  // Add graph node
  const node: GraphNode = {
    id: `exec:${entry.execId}`,
    type: "exec",
    execId: entry.execId,
    label: entry.label,
    sessionId: entry.sessionId,
  };
  manifest.graph.nodes.push(node);
}

/**
 * Add a dependency edge to the manifest graph.
 */
export function addDependsOnEdge(
  manifest: RunManifest,
  fromExecId: string,
  toExecId: string
): void {
  manifest.graph.edges.push({
    type: "dependsOn",
    from: `exec:${fromExecId}`,
    to: `exec:${toExecId}`,
  });
}

/**
 * Add an invokes edge to the manifest graph.
 */
export function addInvokesEdge(
  manifest: RunManifest,
  fromExecId: string,
  toExecId: string
): void {
  manifest.graph.edges.push({
    type: "invokes",
    from: `exec:${fromExecId}`,
    to: `exec:${toExecId}`,
  });
}

/**
 * Add a warning to the manifest.
 */
export function addWarning(manifest: RunManifest, message: string): void {
  manifest.graph.warnings.push(message);
}

/**
 * Finalize the run.
 */
export function finalizeRun(manifest: RunManifest): void {
  manifest.finishedAt = new Date().toISOString();
}
