---
name: skill-inventory
description: List available skills in this workspace and summarize what each does by reading SKILL.md frontmatter.
---

<!--
Business intent: Provide a concise, reliable inventory of skills available in this workspace
(from `.codex/skills` and `src/skills`) using each SKILL.md frontmatter.
Gotcha: Do not infer capabilities beyond the `description`; report duplicates explicitly.
-->

# Skill Inventory

## Scope

Report skills discoverable in these roots (if they exist):
- `.codex/skills`
- `src/skills`

## Procedure

1) Enumerate `SKILL.md` files under the roots.
   - Prefer `rg --files -g "SKILL.md" .codex/skills src/skills` (skip missing roots).
2) For each `SKILL.md`, read the YAML frontmatter (`name`, `description`).
3) If frontmatter is missing or malformed, fall back to directory name and note the issue.
4) If multiple skills share the same `name`, list all and mark as duplicate names.

## Output (default)

- Provide a concise bullet list sorted by skill name:
  - `<name>`: `<description>` (source: `<path>`)

## Output (if asked for machine-readable)

- Return JSON: `{ "skills": [{ "name": "...", "description": "...", "source": "..." }] }`

## Safety

- Do not modify or create files; report only.
