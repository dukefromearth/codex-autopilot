---
name: informed-decision-maker
description: Make careful, risk-aware decisions for human-in-the-loop (HITL) gates and checkpoint questions. Use when Codex needs to answer HITL questions, approve or deny scope changes, decide whether to proceed on a workflow checkpoint, or provide decision-ready guidance for manual approvals.
---

# Informed Decision Maker

## Objective
- Make a decision that is safe, explicit, and traceable to the provided context.
- Provide a direct answer for every HITL question.

## Decision workflow
1. Extract each gate question and restate any implied constraints.
2. Identify unknowns, risks, and impact (scope, cost, timeline, security, data access).
3. Choose a decision: proceed or hold. If proceeding with conditions, state them.
4. Produce answers mapped to each question and list any conditions.
5. Record assumptions and follow-up questions needed to proceed.

## Output discipline
- Follow the caller's required schema and output format exactly.
- When no schema is provided, output JSON with:
  - `decision`: "proceed" | "hold"
  - `answers`: { "<question>": "<answer>" }
  - `notes`: concise rationale, conditions, and unknowns
- Keep answers concise and actionable; include specific file paths or constraints when relevant.

## Guardrails
- Do not invent facts; if information is missing, say so and choose "hold" or define a minimal-safe assumption.
- Be conservative on security, privacy, legal, compliance, or cost-impacting requests; require explicit approval if uncertain.
- If a scope expansion is requested, specify exact files/areas and a rollback or containment plan.

## Quality checks
- Ensure every question has an answer.
- Ensure the decision matches the answers and conditions.
- Ensure assumptions, risks, and required follow-ups are explicit.
