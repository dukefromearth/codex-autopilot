/**
 * Autopilot Run Viewer UI (no-build, no-deps browser app)
 *
 * Business intent:
 * - Provide a small, robust client for the run viewer server APIs.
 * - Prefer DOM APIs (`textContent`) over `innerHTML` for safety and simplicity.
 *
 * Gotchas:
 * - Events view reads and pretty-prints JSONL; large runs can be slow to render in-browser.
 * - "Transcript" is best-effort: it depends on local Codex session persistence.
 */

const state = {
  runs: [],
  run: null,
  exec: null,
  tab: "Overview",
  transcriptPath: null,
  runFilter: "",
  execFilter: "",
  eventsFilter: { type: "", text: "" },
  eventsAbortController: null,
};

const tabs = ["Overview", "Graph", "Output", "Prompt", "Events", "Stderr", "Transcript"];

const runsEl = document.getElementById("runs");
const execsEl = document.getElementById("execs");
const tabsEl = document.getElementById("tabs");
const panelEl = document.getElementById("panel");
const refreshBtn = document.getElementById("refresh-runs");
const runFilterEl = document.getElementById("run-filter");
const execFilterEl = document.getElementById("exec-filter");

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null) continue;
      if (key === "className") node.className = value;
      else if (key.startsWith("data-")) node.setAttribute(key, String(value));
      else if (key in node) node[key] = value;
      else node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child == null) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function setPanelEmpty(message) {
  clear(panelEl);
  panelEl.appendChild(el("div", { className: "empty" }, message));
}

function abortEventsStream() {
  if (state.eventsAbortController) {
    state.eventsAbortController.abort();
    state.eventsAbortController = null;
  }
}

function renderTabs() {
  clear(tabsEl);
  for (const tab of tabs) {
    const btn = el("div", { className: "tab" + (state.tab === tab ? " active" : "") }, tab);
    btn.addEventListener("click", () => {
      state.tab = tab;
      renderPanel();
    });
    tabsEl.appendChild(btn);
  }
}

function renderRuns() {
  clear(runsEl);
  const filter = (state.runFilter || "").toLowerCase();
  const visible = state.runs.filter((r) => (r.runId || "").toLowerCase().includes(filter));
  if (!visible.length) {
    runsEl.appendChild(el("div", { className: "empty" }, state.runs.length ? "No matches." : "No runs found."));
    return;
  }
  for (const run of visible) {
    const card = el("div", { className: "item" + (state.run?.runId === run.runId ? " active" : "") });
    card.appendChild(el("div", { className: "title" }, run.runId));
    card.appendChild(el("div", { className: "subtitle" }, run.startedAt || ""));
    card.addEventListener("click", () => selectRun(run.runId));
    runsEl.appendChild(card);
  }
}

function renderExecs() {
  clear(execsEl);
  if (!state.run) {
    execsEl.appendChild(el("div", { className: "empty" }, "Select a run."));
    return;
  }
  const filter = (state.execFilter || "").toLowerCase();
  const visible = (state.run.execs || []).filter((exec) => {
    const haystack = `${exec.execId || ""} ${exec.label || ""} ${exec.status || ""}`.toLowerCase();
    return haystack.includes(filter);
  });
  if (!visible.length) {
    execsEl.appendChild(el("div", { className: "empty" }, "No matches."));
    return;
  }
  for (const exec of visible) {
    const card = el("div", { className: "item" + (state.exec?.execId === exec.execId ? " active" : "") });
    card.appendChild(el("div", { className: "title" }, exec.execId));
    card.appendChild(el("div", { className: "subtitle" }, `${exec.label} • ${exec.status}`));
    card.addEventListener("click", () => selectExec(exec.execId));
    execsEl.appendChild(card);
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function fetchText(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

async function selectRun(runId) {
  abortEventsStream();
  state.transcriptPath = null;
  state.run = null;
  state.exec = null;
  renderExecs();
  setPanelEmpty("Loading run…");
  try {
    state.run = await fetchJson(`/api/runs/${runId}/manifest`);
    state.exec = state.run.execs?.[0] || null;
    renderRuns();
    renderExecs();
    renderPanel();
  } catch {
    state.run = null;
    state.exec = null;
    renderRuns();
    renderExecs();
    setPanelEmpty("Failed to load run manifest.");
  }
}

function selectExec(execId) {
  abortEventsStream();
  state.transcriptPath = null;
  state.exec = state.run?.execs?.find((e) => e.execId === execId) || null;
  renderExecs();
  renderPanel();
}

function makeChip(text) {
  return el("div", { className: "chip" }, text);
}

function makeTableHeader(columns) {
  const thead = el("thead");
  const row = el("tr");
  for (const col of columns) row.appendChild(el("th", null, col));
  thead.appendChild(row);
  return thead;
}

function makeCell(text) {
  return el("td", null, text == null ? "" : String(text));
}

function makeEmptyRow(colspan, message) {
  const row = el("tr");
  const cell = el("td", { colspan: String(colspan) }, message);
  row.appendChild(cell);
  return row;
}

async function loadRunText(relPath, opts) {
  if (!state.run || !relPath) return null;
  try {
    return await fetchText(`/api/runs/${state.run.runId}/file?path=${encodeURIComponent(relPath)}`, opts);
  } catch {
    return null;
  }
}

function escapeShellDoubleQuotes(text) {
  return String(text).replace(/[\\$"`]/g, (match) => "\\" + match);
}

function renderPanel() {
  renderTabs();
  if (state.tab !== "Events") abortEventsStream();
  if (!state.run) {
    setPanelEmpty("Select a run to inspect.");
    return;
  }
  switch (state.tab) {
    case "Overview":
      renderOverview();
      return;
    case "Graph":
      renderGraph();
      return;
    case "Output":
      renderFilePanel("Output", state.exec?.artifacts?.lastMessageTxt);
      return;
    case "Prompt":
      renderFilePanel("Prompt", state.exec?.artifacts?.promptTxt);
      return;
    case "Events":
      renderEvents();
      return;
    case "Stderr":
      renderFilePanel("Stderr", state.exec?.artifacts?.stderrTxt);
      return;
    case "Transcript":
      renderTranscript();
      return;
  }
  setPanelEmpty("Unknown tab.");
}

function renderOverview() {
  if (!state.exec) {
    setPanelEmpty("Select an exec.");
    return;
  }
  const exec = state.exec;
  clear(panelEl);
  panelEl.appendChild(el("h3", null, "Run Overview"));
  const chips = el("div", { className: "row" });
  chips.append(
    makeChip(`Run: ${state.run.runId}`),
    makeChip(`Exec: ${exec.execId}`),
    makeChip(`Thread: ${exec.threadId}`),
    makeChip(`Status: ${exec.status}`),
  );
  panelEl.appendChild(chips);

  const buttons = el("div", { className: "buttons" });
  const resumeBtn = el("button", { type: "button", className: "primary", disabled: !(exec.threadId && exec.artifacts?.promptTxt) }, "Copy resume command");
  const transcriptBtn = el("button", { type: "button", disabled: !exec.threadId }, "Copy open transcript path");
  buttons.append(resumeBtn, transcriptBtn);
  panelEl.appendChild(buttons);

  const detail = el("div", null);
  detail.append(
    el("div", null, el("strong", null, "Exec label: "), String(exec.label || "")),
    el("div", null, el("strong", null, "Started: "), String(exec.startedAt || "")),
    el("div", null, el("strong", null, "Finished: "), String(exec.finishedAt || "")),
    el("div", null, el("strong", null, "Exit code: "), String(exec.exitCode)),
  );
  panelEl.appendChild(detail);

  resumeBtn.addEventListener("click", async () => {
    const promptText = await loadRunText(exec.artifacts?.promptTxt);
    if (!promptText) return;
    const escaped = escapeShellDoubleQuotes(promptText.replace(/\n/g, " "));
    const cmd = `codex exec resume ${exec.threadId} "${escaped}"`;
    await navigator.clipboard.writeText(cmd);
  });

  transcriptBtn.addEventListener("click", async () => {
    if (!exec.threadId) return;
    try {
      const payload = await fetchJson(`/api/transcript/${exec.threadId}?meta=1`);
      if (payload?.path) await navigator.clipboard.writeText(payload.path);
    } catch {
      // ignore
    }
  });
}

function renderGraph() {
  const graph = state.run.graph;
  clear(panelEl);
  if (!graph) {
    setPanelEmpty("No graph recorded.");
    return;
  }
  panelEl.appendChild(el("h3", null, "Graph"));
  if (graph.warnings?.length) {
    const warningsRow = el("div", { className: "row" });
    for (const warning of graph.warnings) warningsRow.appendChild(makeChip(warning));
    panelEl.appendChild(warningsRow);
  }

  panelEl.appendChild(el("h4", null, "Nodes"));
  const nodesTable = el("table");
  nodesTable.appendChild(makeTableHeader(["Id", "Type", "Label", "Exec", "Thread", ""]));
  const nodesBody = el("tbody");
  if (!graph.nodes?.length) {
    nodesBody.appendChild(makeEmptyRow(6, "No nodes"));
  } else {
    for (const node of graph.nodes) {
      const row = el("tr");
      const execId = node.type === "exec" ? node.execId : "-";
      const label = node.type === "exec" ? node.label : "thread";
      row.append(makeCell(node.id), makeCell(node.type), makeCell(label), makeCell(execId), makeCell(node.threadId || ""));
      const actionCell = el("td");
      if (node.type === "exec" && execId) {
        const btn = el("button", { type: "button" }, "Open");
        btn.addEventListener("click", () => {
          selectExec(execId);
          state.tab = "Overview";
          renderPanel();
        });
        actionCell.appendChild(btn);
      }
      row.appendChild(actionCell);
      nodesBody.appendChild(row);
    }
  }
  nodesTable.appendChild(nodesBody);
  panelEl.appendChild(nodesTable);

  panelEl.appendChild(el("h4", null, "Edges"));
  const edgesTable = el("table");
  edgesTable.appendChild(makeTableHeader(["Type", "From", "To", "Source"]));
  const edgesBody = el("tbody");
  if (!graph.edges?.length) {
    edgesBody.appendChild(makeEmptyRow(4, "No edges"));
  } else {
    for (const edge of graph.edges) {
      const row = el("tr");
      row.append(makeCell(edge.type), makeCell(edge.from), makeCell(edge.to), makeCell(edge.source || ""));
      edgesBody.appendChild(row);
    }
  }
  edgesTable.appendChild(edgesBody);
  panelEl.appendChild(edgesTable);
}

async function renderFilePanel(label, relPath) {
  clear(panelEl);
  panelEl.appendChild(el("h3", null, label));
  if (!state.exec || !relPath) {
    panelEl.appendChild(el("div", { className: "empty" }, `No ${label.toLowerCase()} captured.`));
    return;
  }
  const text = await loadRunText(relPath);
  if (text == null) {
    panelEl.appendChild(el("div", { className: "empty" }, `Unable to load ${label.toLowerCase()}.`));
    return;
  }
  const pre = el("pre");
  pre.textContent = text;
  panelEl.appendChild(pre);
}

function renderEvents() {
  if (!state.exec?.artifacts?.eventsJsonl) {
    setPanelEmpty("No events captured.");
    return;
  }
  clear(panelEl);
  panelEl.appendChild(el("h3", null, "Events"));
  const typeInput = el("input", { type: "text", value: state.eventsFilter.type, placeholder: "Filter by event.type" });
  const textInput = el("input", { type: "text", value: state.eventsFilter.text, placeholder: "Search text" });
  const reloadButton = el("button", { type: "button" }, "Reload");
  const filters = el("div", { className: "filters" }, typeInput, textInput, reloadButton);
  const log = el("pre", { id: "events-log" }, "Loading…");
  panelEl.append(filters, log);

  reloadButton.addEventListener("click", () => {
    state.eventsFilter.type = typeInput.value.trim();
    state.eventsFilter.text = textInput.value.trim();
    streamEvents(log);
  });
  streamEvents(log);
}

function filterEventLine(line, filters) {
  let json;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  const type = json.type || json.event?.type || json.payload?.type || "";
  if (filters.type && !String(type).includes(filters.type)) return null;
  if (filters.text && !line.includes(filters.text)) return null;
  return JSON.stringify(json, null, 2);
}

async function streamEvents(logEl) {
  if (!state.exec?.artifacts?.eventsJsonl) return;
  abortEventsStream();
  const controller = new AbortController();
  state.eventsAbortController = controller;
  logEl.textContent = "";

  let res;
  try {
    res = await fetch(
      `/api/runs/${state.run.runId}/file?path=${encodeURIComponent(state.exec.artifacts.eventsJsonl)}`,
      { signal: controller.signal },
    );
  } catch {
    if (controller.signal.aborted) return;
    logEl.textContent = "Failed to stream events.";
    return;
  }
  if (!res.ok || !res.body) {
    if (!controller.signal.aborted) logEl.textContent = "Failed to stream events.";
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let shown = 0;

  const appendChunk = (text) => {
    if (!text) return;
    if (state.eventsAbortController !== controller) return;
    logEl.appendChild(document.createTextNode(text));
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      let chunk = "";
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const formatted = filterEventLine(line, state.eventsFilter);
        if (formatted) {
          chunk += formatted + "\n";
          shown += 1;
        }
      }
      appendChunk(chunk);
    }
  } catch {
    if (!controller.signal.aborted) logEl.textContent = "Failed to stream events.";
    return;
  }

  if (buffer.trim()) {
    const formatted = filterEventLine(buffer.trim(), state.eventsFilter);
    if (formatted) {
      appendChunk(formatted + "\n");
      shown += 1;
    }
  }
  if (controller.signal.aborted) return;
  if (shown === 0) logEl.textContent = "No events matched the filter.";
}

async function renderTranscript() {
  if (!state.exec?.threadId) {
    setPanelEmpty("No thread id available.");
    return;
  }
  clear(panelEl);
  panelEl.appendChild(el("h3", null, "Transcript (Supplemental)"));
  const buttons = el("div", { className: "buttons" });
  const copyBtn = el("button", { type: "button", disabled: true }, "Copy open transcript path");
  buttons.appendChild(copyBtn);
  panelEl.appendChild(buttons);
  const pre = el("pre", null, "Loading…");
  panelEl.appendChild(pre);

  try {
    const meta = await fetchJson(`/api/transcript/${state.exec.threadId}?meta=1`);
    state.transcriptPath = meta?.path || null;
    copyBtn.disabled = !state.transcriptPath;
  } catch {
    state.transcriptPath = null;
  }

  try {
    const text = await fetchText(`/api/transcript/${state.exec.threadId}`);
    pre.textContent = text;
  } catch (error) {
    pre.textContent = "Transcript not found.";
  }

  copyBtn.addEventListener("click", async () => {
    if (!state.transcriptPath) return;
    await navigator.clipboard.writeText(state.transcriptPath);
  });
}

async function loadRuns() {
  try {
    state.runs = await fetchJson("/api/runs");
  } catch {
    state.runs = [];
  }
  renderRuns();
  if (!state.run && state.runs.length) {
    await selectRun(state.runs[0].runId);
  } else {
    renderExecs();
    renderPanel();
  }
}

function wireUi() {
  refreshBtn?.addEventListener("click", () => loadRuns());
  runFilterEl?.addEventListener("input", () => {
    state.runFilter = runFilterEl.value || "";
    renderRuns();
  });
  execFilterEl?.addEventListener("input", () => {
    state.execFilter = execFilterEl.value || "";
    renderExecs();
  });
}

wireUi();
loadRuns();

