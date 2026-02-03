<!--
Business intent: Standalone home for the Codex Autopilot runner + run viewer so they can evolve
independently of the multi-agent runtime scaffold.
Gotchas: Both scripts assume a local-only environment; the run viewer serves local files over HTTP.
-->

# Codex Autopilot

This repo contains:
- `examples/codex-autopilot.ts`: a minimal “autopilot” runner that orchestrates `codex exec` calls and writes run captures under `runs/autopilot/`.
- `examples/run-viewer.ts`: a zero-deps local run viewer UI for inspecting those captures.

## Setup

```bash
npm install
```

## Run autopilot

```bash
npm run autopilot -- \"<task>\"
```

## Run the viewer

```bash
npm run viewer
```

Open `http://127.0.0.1:4141`.

More details: `docs/run-data-ui.md`.
