#!/usr/bin/env node
/**
 * Autopilot CLI entry point.
 */

import process from "node:process";
import { run } from "./runner.js";
import { createAdapter } from "./adapters/factory.js";
import type { AdapterName } from "./adapters/types.js";
import type { RunOptions } from "./state/types.js";

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_ITERATIONS = 4;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const parsed = parseArgs(args);

  if (!parsed) {
    printHelp();
    process.exit(1);
  }

  try {
    const adapter = await createAdapter(parsed.adapter);
    const result = await run({
      task: parsed.task,
      adapter,
      options: {
        adapter: parsed.adapter,
        model: parsed.model,
        concurrency: parsed.concurrency,
        maxIterations: parsed.maxIterations,
        unsafe: parsed.unsafe,
      },
      outDir: parsed.outDir,
    });

    console.log(`\n[autopilot] Run ID: ${result.runId}`);
    console.log(`[autopilot] Status: ${result.status}`);

    if (result.error) {
      console.error(`[autopilot] Error: ${result.error}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`[autopilot] Fatal error:`, error);
    process.exit(1);
  }
}

interface ParsedArgs {
  task: string;
  adapter: AdapterName;
  model: string;
  concurrency: number;
  maxIterations: number;
  unsafe: boolean;
  outDir: string;
}

function parseArgs(argv: string[]): ParsedArgs | null {
  let adapter: AdapterName = "claude";
  let model = DEFAULT_MODEL;
  let concurrency = DEFAULT_CONCURRENCY;
  let maxIterations = DEFAULT_MAX_ITERATIONS;
  let unsafe = false;
  let outDir = "runs/autopilot";
  const taskParts: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--adapter" || arg === "-a") {
      const value = argv[++i];
      if (value === "claude" || value === "codex") {
        adapter = value;
      }
      continue;
    }
    if (arg.startsWith("--adapter=")) {
      const value = arg.slice("--adapter=".length);
      if (value === "claude" || value === "codex") {
        adapter = value;
      }
      continue;
    }

    if (arg === "--model" || arg === "-m") {
      model = argv[++i] ?? model;
      continue;
    }
    if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
      continue;
    }

    if (arg === "--concurrency" || arg === "-c") {
      concurrency = parseInt(argv[++i] ?? "", 10) || DEFAULT_CONCURRENCY;
      continue;
    }
    if (arg.startsWith("--concurrency=")) {
      concurrency = parseInt(arg.slice("--concurrency=".length), 10) || DEFAULT_CONCURRENCY;
      continue;
    }

    if (arg === "--max-iterations") {
      maxIterations = parseInt(argv[++i] ?? "", 10) || DEFAULT_MAX_ITERATIONS;
      continue;
    }
    if (arg.startsWith("--max-iterations=")) {
      maxIterations = parseInt(arg.slice("--max-iterations=".length), 10) || DEFAULT_MAX_ITERATIONS;
      continue;
    }

    if (arg === "--unsafe") {
      unsafe = true;
      continue;
    }

    if (arg === "--out-dir" || arg === "-o") {
      outDir = argv[++i] ?? outDir;
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

  return {
    task,
    adapter,
    model,
    concurrency: Math.max(1, concurrency),
    maxIterations: Math.max(1, maxIterations),
    unsafe,
    outDir,
  };
}

function printHelp(): void {
  console.log(`
Usage:
  npx autopilot [options] "<task>"

Options:
  --adapter, -a <name>     Adapter: claude (default) or codex
  --model, -m <model>      Model to use (default: ${DEFAULT_MODEL})
  --concurrency, -c <n>    Max parallel steps (default: ${DEFAULT_CONCURRENCY})
  --max-iterations <n>     Max plan/execute cycles (default: ${DEFAULT_MAX_ITERATIONS})
  --unsafe                 Bypass approvals/sandbox (dangerous)
  --out-dir, -o <dir>      Output directory (default: runs/autopilot)
  --help, -h               Show this help

Examples:
  npx autopilot "Fix the authentication bug in src/auth.ts"
  npx autopilot --adapter codex "Implement user profile feature"
  npx autopilot --model claude-opus-4-20250514 --max-iterations 6 "Complex refactor"
`.trim());
}

main();
