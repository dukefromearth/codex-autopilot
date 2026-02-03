<!--
Business intent: document the run-capture artifacts needed by a UI to render Codex runs deterministically,
including the local manifest and per-exec stdout/stderr captures, without relying on Codex internal paths.
Gotchas: treat these conventions as “local contract” that may change; always read the manifest first.
-->
# Run Data & UI Viewer Notes (Codex CLI)

This is a **living** reference for what we currently (empirically) know about the data emitted and persisted by `codex exec`, and what a dedicated UI needs to surface to make runs debuggable and resumable.

Primary goal: make “emergent autonomy” observable and steerable with **minimal extra orchestration code** by treating `codex exec` sessions (`thread_id`) as the unit of work, and `codex exec resume` as the core HITL/gating primitive.

## Working Definitions

- **Thread / session (`thread_id`)**: Stable identifier for a Codex conversation. This is the handle you resume.
- **Turn**: One prompt/response cycle inside a thread. Resuming appends a new turn to the same thread.
- **Item**: A unit within a turn (agent message, tool call, command execution, patch apply, etc.). Some streams report explicit item boundaries.
- **Run (local concept)**: Usually “one thread”. For a multi-step workflow, you may also want a higher-level “workflow run” that groups many threads.
- **Workflow (local concept)**: A DAG (or ordered list) of steps where each step may be executed by its own `codex exec` thread.

## Data Sources You Can Build a UI From

### 1) Live event stream: `codex exec --json`

- `codex exec --json ...` prints JSONL events to stdout.
- The **first line** includes the durable id: `{"type":"thread.started","thread_id":"..."}`.
- This stream is the easiest way to implement “run capture” without relying on Codex’s internal persistence paths.

### 2) Persisted session transcript: `~/.codex/sessions/**/rollout-…-<thread_id>.jsonl`

Codex stores detailed JSONL logs under the Codex home directory:

- Default Codex home: `~/.codex` (unless `CODEX_HOME` is set).
- Sessions root: `~/.codex/sessions/YYYY/MM/DD/`
- Filename pattern includes the `thread_id` as a suffix: `rollout-…-<thread_id>.jsonl`

The persisted session transcript contains richer structured events than the `--json` stdout stream (including `turn_context`, tool call pairing, and token accounting).

### 3) History index: `~/.codex/history.jsonl`

`~/.codex/history.jsonl` appears to record high-level history entries (e.g., prompts) keyed by `session_id`. This can be used as a lightweight “recent runs” index, but it’s not a full-fidelity transcript.

### 4) TUI log: `~/.codex/log/codex-tui.log`

Useful for debugging the Codex client itself (UI issues, crashes, etc.), not primarily for run viewing.

### 5) Canonical protocol schemas: `codex app-server generate-json-schema`

Codex can emit JSON Schemas (and TS bindings) for its app-server protocol:

- `codex app-server generate-json-schema --out <dir>`
- `codex app-server generate-ts --out <dir>`

Even if you don’t run `codex app-server` directly, these generated schemas are valuable as a **stable reference** for event payload shapes you may see in transcripts.

## What You Know “Immediately” When an `exec` Starts

### If you use `--json`

- You immediately receive `thread_id` from `thread.started`.
- Because you invoked the command, you also know (externally) the cwd, model, config overrides, sandbox mode, approval policy, etc.

### Persisted logs confirm / enrich early metadata

The persisted session JSONL begins with `session_meta` and includes `turn_context` entries that record key runtime settings, such as:

- `cwd`
- `approval_policy`
- `sandbox_policy`
- `model`
- `effort` / reasoning effort
- collaboration settings (when relevant)

## Retaining Run Metadata Elegantly (Minimal Glue)

If the UI wants to list runs reliably, don’t depend on “discovering” Codex’s internal paths at runtime. Instead:

1. Always run `codex exec --json ...`
2. Tee stdout JSONL to a file you control (a “captured stream”)
3. Parse the first event to capture `thread_id`
4. Write a tiny **run manifest** alongside it

Suggested `RunManifest` shape (informal):

```ts
type RunManifest = {
  runId: string; // your own id (optional)
  threadId: string; // Codex thread_id (required)
  startedAt: string; // ISO
  finishedAt?: string; // ISO
  status: "running" | "done" | "error" | "aborted";
  cwd: string;
  model?: string;
  modelReasoningEffort?: "low" | "medium" | "high" | "xhigh";
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  capturedJsonlPath?: string; // tee target
  codexSessionJsonlPathHint?: string; // optional convenience hint (may be discovered later)
};
```

### Autopilot capture layout (examples/codex-autopilot.ts)

The autopilot runner now persists **per-exec artifacts** for each `codex exec` invocation
(workflow generation, each workflow step, completion check) and indexes them via a manifest.
This is the reference layout for future UI work:

```
runs/autopilot/
  autopilot-2026-02-03T18-29-12-123Z.json        # legacy runState (back-compat)
  autopilot-2026-02-03T18-29-12-123Z/
    manifest.json                               # run index (see below)
    exec-001-workflow-gen-iteration-1/
      events.jsonl                              # raw stdout JSONL, as received
      stderr.txt                                # raw stderr
      last_message.txt                          # codex exec --output-last-message
      prompt.txt                                # exact prompt string passed to codex
      argv.json                                 # full argv array used to spawn codex
    exec-002-step-discover/
      events.jsonl
      stderr.txt
      last_message.txt
      prompt.txt
      argv.json
    exec-003-completion-check-iteration-1/
      events.jsonl
      stderr.txt
      last_message.txt
      prompt.txt
      argv.json
      schema.json                             # optional if --output-schema is used
```

`manifest.json` (informal):

```ts
type RunManifest = {
  runId: string;
  startedAt: string; // ISO
  finishedAt?: string; // ISO
  cwd: string;
  options: {
    model: string;
    effort: "minimal" | "low" | "medium" | "high" | "xhigh";
    concurrency: number;
    unsafe: boolean;
    search: boolean;
  };
  execs: Array<{
    execId: string; // stable exec identifier (also the exec folder prefix)
    label: string; // stable label for the exec call (workflow-gen, step:<id>, completion-check)
    threadId: string;
    status: "succeeded" | "failed";
    exitCode: number;
    startedAt: string; // ISO
    finishedAt: string; // ISO
    artifacts: {
      eventsJsonl: string; // relative to run folder
      stderrTxt: string; // relative to run folder
      lastMessageTxt: string; // relative to run folder
      promptTxt?: string; // relative to run folder
      argvJson?: string; // relative to run folder
      schemaJson?: string; // optional if --output-schema is used
    };
  }>;
  graph: {
    nodes: Array<
      | {
          id: string;
          type: "exec";
          execId: string;
          label: string;
          threadId: string;
          artifacts: RunManifest["execs"][number]["artifacts"];
        }
      | {
          id: string;
          type: "thread";
          threadId: string;
        }
    >;
    edges: Array<{
      type: "dependsOn" | "invokes" | "resume" | "spawn" | "interact";
      from: string;
      to: string;
      callId?: string;
      status?: string;
      prompt?: string;
      source?: "workflow" | "resume" | "transcript";
    }>;
    warnings: string[];
  };
};
```

Notes:
- `events.jsonl` is the **stdout JSONL** stream written exactly as received (raw bytes from stdout).
- `stderr.txt` captures the **stderr** stream for each exec, also as received.
- `last_message.txt` is the canonical `outputText` used by the runner for deterministic parsing.
- `prompt.txt` is the exact prompt string passed to `codex exec`.
- `argv.json` is the full argv array used to spawn `codex` (includes `codex` as argv[0]).

## MVP Run Viewer (examples/run-viewer.ts)

The repo includes a zero-deps run viewer that serves a local HTML UI and read-only APIs:

```bash
node --import tsx examples/run-viewer.ts --port 4141
```

Optional flags:
- `--host <host>`: Bind address (default `127.0.0.1`).
- `--codex-home <path>`: Override `~/.codex` when searching for session transcripts.

### API surface (read-only)

- `GET /api/runs`: List available run manifests under `runs/autopilot/*/manifest.json`.
- `GET /api/runs/:runId/manifest`: Load a single run manifest by `runId`.
- `GET /api/runs/:runId/file?path=<manifest-relative>`: Stream a manifest-relative artifact (path traversal is rejected).
- `GET /api/transcript/:threadId`: Best-effort stream of the `rollout-*-<threadId>.jsonl` transcript under Codex home.

### What it reads

- Canonical data: `runs/autopilot/<runId>/manifest.json` plus the manifest-relative artifacts for each exec.
- Supplemental data: `~/.codex/sessions/**/rollout-*-<threadId>.jsonl` (best-effort transcript lookup).

The UI treats `manifest.json` as the source of truth for run structure, timestamps, and artifact paths.
Transcripts are explicitly labeled supplemental because they can be absent or incomplete.

### Security notes

- The viewer serves local files from the run folder over HTTP. Keep it bound to localhost unless you
  understand the risks of exposing local filesystem contents on your network.
- The transcript endpoint will stream a local `rollout-*.jsonl` file if found; avoid using the viewer
  on untrusted networks or devices.
- The UI renders manifest-derived text as plain text (no HTML), and the API validates `runId` and file
  paths (including symlinks) to avoid path traversal when resolving artifacts.
- The “Copy resume command” button shell-escapes the prompt for a double-quoted POSIX shell string, but
  still review before running if your shell or prompt content is unusual.
- `schema.json` is only present when the runner passes `--output-schema` to `codex exec`.
- `manifest.json` is the **index**; UI consumers should not guess paths.
- Failed execs still get a manifest entry with `status:"failed"`, an `exitCode`, artifact paths, and a stable `execId`
  so graph edges can still link to them.
- If `codex` fails to spawn or stdio is missing, `events.jsonl` may be empty and `threadId` may be `unknown`;
  `stderr.txt` includes spawn/process error text when available.
- `graph.warnings` records best-effort enrichment failures (e.g., transcript lookup/parsing misses).

This gives the UI a stable index even if Codex changes persistence conventions later.

## Provenance / Call Graph (Autopilot)

The autopilot runner enriches `manifest.json` with a lightweight provenance graph that links exec
invocations and any discovered Codex threads (e.g., spawned collaborators):

- **Nodes**:
  - `type:"exec"` nodes represent each `codex exec` invocation (execId, label, threadId, artifacts).
  - `type:"thread"` nodes represent additional threads discovered in transcripts when no exec node exists.
- **Edges**:
  - `dependsOn`: derived from `workflow.steps[].dependsOn` (dependency exec → dependent exec).
  - `invokes`: workflow-gen → step execs, step execs → completion-check, completion-check → next workflow-gen.
    - If the reviewer supplies `nextWorkflow`, there is **no separate workflow-gen exec**. The
      completion-check exec acts as the workflow-gen node for the next iteration and invokes the
      subsequent step execs directly.
  - `resume`: emitted when an exec uses `codex exec resume` (thread state → resumed exec).
  - `spawn` / `interact`: derived from persisted transcript `event_msg` payloads.
- **Event sources**:
  - `workflow` edges are inferred from the workflow DAG and iteration flow.
  - `resume` edges are inferred from the CLI arguments used to resume a thread.
  - `transcript` edges are best-effort from `~/.codex/sessions/**/rollout-…-<thread_id>.jsonl`.

Best-effort transcript parsing means **missing transcripts do not fail a run**; the runner just omits
those edges and appends a warning in `graph.warnings`.

Transcript enrichment behavior (autopilot):
- Transcript-derived edges always connect **thread nodes** (`thread:<thread_id>` → `thread:<thread_id>`) so
  IDs stay stable even if a thread later has multiple execs.
- Transcript parsing is **idempotent per thread per run**; once a thread’s transcript is processed, it won’t
  be re-parsed (to avoid duplicate edges on resume).
- Transcript edges are deduped by: `call_id + event type + sender thread_id + target thread_id + status`
  (prompt text is not part of the dedupe identity).
- The runner records warnings for missing transcripts and any unexpected `call_id` collisions.

## Transcript/Event Shapes to Support in the UI

There are (at least) two “layers” of event streams you may choose to display:

### A) `codex exec --json` stream (stdout)

Empirically observed event types include:

- `thread.started` (contains `thread_id`)
- `turn.started`
- `item.started` / `item.completed` (items include `type` like `agent_message`)
- `turn.completed` (includes token usage summary)

This stream is great for a minimal live UI, but it may not include every structured detail you can find in persisted transcripts.

### B) Persisted `~/.codex/sessions/.../*.jsonl` transcript

Empirically observed top-level record `type` values:

- `session_meta` (session header; includes `id` and base instructions)
- `turn_context` (records runtime settings for the upcoming turn)
- `event_msg` (high-level UI events; includes token counts, deltas, etc.)
- `response_item` (structured model output items; tool calls, messages, etc.)
- `compacted` (context compaction marker; rare)

Common `event_msg.payload.type` values to render:

- `user_message`
- `agent_message`
- `agent_reasoning` (UI-friendly reasoning text)
- `token_count`
- `turn_aborted`
- `context_compacted`

Common `response_item.payload.type` values to render:

- `message` (role + content parts)
- `reasoning` (**note**: has `summary` + `encrypted_content`; don’t assume raw chain-of-thought is available)
- `function_call` / `function_call_output` (join via `call_id`)
- `custom_tool_call` / `custom_tool_call_output` (join via `call_id`, e.g. `apply_patch`)
- `web_search_call` (if enabled)

### C) App-server `EventMsg` union (schema-driven)

The generated schema enumerates many event variants (commands, approvals, deltas, undo, MCP, etc.). If you want to be schema-driven, treat the schema as canonical and implement rendering incrementally by category.

## UI: What To Surface (MVP → “Actually Useful”)

### Run list (table)

- `thread_id`
- start/end/duration
- cwd
- model + reasoning effort
- sandbox/approval settings
- status (done/error/aborted)
- token usage (when available)

### Run detail (timeline)

- Group by **turn**
- Within a turn, show:
  - user messages
  - agent messages
  - tool calls + outputs (paired by `call_id`)
  - command execution begin/end + streamed output deltas (when present)
  - patch/diff events
  - warnings/errors
  - token usage snapshots

### Resume/gating UX (core)

Treat “gates” as a first-class UI action:

- Show a “Resume” button that runs: `codex exec resume <thread_id> "<prompt>"`
- Also show “copy resume command” for CLI-native control.

### Workflow view (if each node is `codex exec`)

If a higher-level workflow step spawns multiple `codex exec` threads, the UI should:

- Render a DAG of steps
- Each node links to its thread transcript
- Group steps under a workflow-run id (separate from thread ids)

### Search & filtering

- By event type (`error`, `exec_command_*`, `apply_patch`, etc.)
- By file path (grep within tool outputs / diffs)
- By tool (`apply_patch`, `mcp_tool_call_*`, etc.)

### Export/import

- Export run manifest + captured JSONL + relevant session transcript(s) into a single folder or archive.
- This enables sharing “a run” without requiring the receiver’s `~/.codex` state.

## HITL / Approvals: Minimal-but-Effective Gating

The simplest gating model:

- Each workflow node is a `codex exec` call.
- If a node needs human input, it asks a question and stops.
- The operator resumes the same `thread_id` with `codex exec resume ...`.

This avoids implementing a custom HITL protocol as long as:

- The UI can locate and present “questions” (often `agent_message`)
- The UI can resume threads with additional user input

## Useful CLI Flags for Structured Output

- `codex exec --json ...` (capture live event stream)
- `codex exec --output-last-message <file> ...` (write final assistant message to a file)
- `codex exec --output-schema <schema.json> ...` (validate/shape the final response)
- `codex exec resume --json <thread_id> "<prompt>"` (HITL continuation)

## Open Questions / Design Decisions

- **Which is source-of-truth for UI?**
  - Captured `--json` stream (you control it; simpler)
  - Persisted sessions transcript (richer; path discovery needed)
  - Or both (captured stream for indexing, persisted transcript for deep dive)
- **How do we group threads into a single “workflow run”?**
  - Store a workflow-run manifest that references many `thread_id`s.
  - Treat the “orchestrator” thread as the root and store edges from it.
- **How stable are event schemas across versions?**
  - Mitigation: generate and vendor schemas (or regenerate at build time) and handle unknown variants gracefully.
