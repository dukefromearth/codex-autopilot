---
name: workflow-generator
description: Generate a runnable WorkflowSpec JSON (aka `workflow.json` / `*.workflow.json`) for this repo's multi-agent runtime, using only the skills available in this workspace. Use when the user asks to "generate a workflow", "create a workflow.json", or wants a WorkflowSpec that does a described task.
---

<!--
Business intent: Convert a natural-language objective into a valid `WorkflowSpec` (DAG of `agent.run` steps)
that this repo can execute, with sensible defaults and skill selection.
Gotcha: Your response must be *only* the JSON object (no prose, no code fences). Do not create files; the
caller may choose to save the JSON to disk.
-->

# Workflow Generator

## Canonical sources (use if unsure)

- Schema + types: `src/workflowSpec/schema.ts`
- Example WorkflowSpec: `configs/workflows/showcase.workflow.json`
- Cheatsheet: `.claude/skills/workflow-spec-creator/references/workflow-spec-cheatsheet.md`

## Output contract (required)

- Output **exactly one** JSON object (a `WorkflowSpec`).
- **No** Markdown fences, **no** commentary, **no** leading/trailing text.
- JSON must be valid (double quotes, no trailing commas).
- Do **not** create or write any files (including `workflow.json`); only return the JSON object.
- Always include: `version: 1`, `id`, `steps` (>= 1), and each step must have `id`, `type: "agent.run"`, `goal`.

## Defaults (use unless the user overrides)

- `defaults.adapterId`: `"claude-sdk"`
- `defaults.adapterRequest`:
  - `model`: `"claude-sonnet-4-20250514"`
  - `modelReasoningEffort`: `"low"`
  - `webSearchMode`: `"disabled"` (enable if websearch is useful for the task)
- Prefer profiles:
  - **scout**: repository discovery / mapping (skills: `researcher`)
  - **executor**: implements changes and runs commands (skills: `task-executor`; set `sandboxMode: "workspace-write"` and `approvalPolicy: "on-request"` unless user asks otherwise)
  - **verifier**: validates behavior (skills: `tester`)
  - **reviewer**: checks risks/regressions (skills: `reviewer`)
  - **architect**: interface/design trade-offs (skills: `architect`)
  - **rewriter**: tightens prompts/outputs (skills: `prompt-rewrite`)

## Skill selection rules (use only skills that exist here)

Use the smallest set of skills that satisfies the request:

- Planning-heavy: add `task-planner`
- Needs repo/context research: add `researcher`
- Needs design/interfaces/trade-offs: add `architect`
- Needs code changes: add `task-executor`
- Needs tests/verification: add `tester`
- Needs critique/risk review: add `reviewer`
- Needs rewriting a prompt/spec or tightening output format: add `prompt-rewrite`
- Needs creating/editing a WorkflowSpec as an artifact: add `workflow-spec-creator`
- Needs a deterministic final summary: add `informed-decision-maker` (optional)

If the request asks for skills not present, omit them and proceed with the closest available alternatives.

## Step design rules (DAG)

- Use clear, stable step ids: `discover`, `plan`, `design`, `implement`, `verify`, `review`, `synthesize`.
- Parallelize only when steps are independent; otherwise express ordering with `dependsOn`.
- If a step consumes prior work, include `dependsOn` and add a short instruction in `inputs` to use `dependencyOutputs.<depId>.outputText` as the source of truth.
- Keep each step’s `goal` singular (one deliverable).

## Common skeletons (pick the smallest that fits)

- **One-shot**: single `agent.run` step when the task is simple.
- **Repo change**: `discover → plan → implement → verify → review`.
- **Design-first**: `discover → design → plan → implement → verify → review`.
- **Just research**: `discover → synthesize`.
