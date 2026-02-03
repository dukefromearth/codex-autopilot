/**
 * Per-execution artifact writing.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunContext, ExecEntry, ExecArtifacts } from "./types.js";

/**
 * Allocate the next execution ID.
 */
export function allocateExecId(context: RunContext): string {
  const id = `exec-${String(context.nextExecIndex).padStart(3, "0")}`;
  context.nextExecIndex++;
  return id;
}

/**
 * Create execution directory and write artifacts.
 */
export async function writeExecArtifacts(
  context: RunContext,
  execId: string,
  label: string,
  prompt: string,
  output: string,
  metadata: Record<string, unknown>
): Promise<ExecArtifacts> {
  const safeLabel = label
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "exec";

  const execDir = path.join(context.runDir, `${execId}-${safeLabel}`);
  await mkdir(execDir, { recursive: true });

  const promptPath = path.join(execDir, "prompt.txt");
  const outputPath = path.join(execDir, "output.txt");
  const metadataPath = path.join(execDir, "metadata.json");

  await Promise.all([
    writeFile(promptPath, prompt, "utf8"),
    writeFile(outputPath, output, "utf8"),
    writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf8"),
  ]);

  return {
    promptTxt: path.relative(context.runDir, promptPath),
    outputTxt: path.relative(context.runDir, outputPath),
    metadataJson: path.relative(context.runDir, metadataPath),
  };
}

/**
 * Create an ExecEntry from execution results.
 */
export function createExecEntry(
  execId: string,
  label: string,
  sessionId: string,
  status: "succeeded" | "failed",
  startedAt: string,
  finishedAt: string,
  artifacts: ExecArtifacts
): ExecEntry {
  return {
    execId,
    label,
    sessionId,
    status,
    startedAt,
    finishedAt,
    artifacts,
  };
}
