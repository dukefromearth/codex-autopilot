<INSTRUCTIONS>
# Codex Autopilot: repository guidance

## Priorities
- Keep the runner + viewer minimal and dependency-light.
- Preserve artifact format compatibility: existing run captures should remain readable by the viewer.
- Favor safety defaults (localhost binding, path validation, no shell injection).

## Workflow & verification
- Run `npm run typecheck` before marking changes complete.
- Run `npm run test` when viewer behavior/tests change.
</INSTRUCTIONS>
