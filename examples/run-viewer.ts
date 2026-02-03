/**
 * Run Viewer (autopilot capture UI)
 *
 * Business intent:
 * - Provide a zero-deps, no-build-step viewer for autopilot run captures under runs/autopilot/.
 * - Serve a tiny static HTML UI plus read-only JSON/file streaming APIs to inspect runs locally.
 *
 * Gotchas:
 * - This serves local files from the run folder; keep it bound to localhost when possible.
 * - Transcript lookup is best-effort and depends on Codex home/session layout.
 */
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { fileURLToPath, pathToFileURL } from "node:url";

type ExecArtifactPaths = {
  eventsJsonl?: string;
  stderrTxt?: string;
  lastMessageTxt?: string;
  promptTxt?: string;
  argvJson?: string;
  schemaJson?: string;
};

type ExecManifestEntry = {
  execId: string;
  label: string;
  threadId: string;
  status: "succeeded" | "failed";
  exitCode: number;
  startedAt: string;
  finishedAt: string;
  artifacts: ExecArtifactPaths;
};

type GraphNode =
  | {
      id: string;
      type: "exec";
      execId: string;
      label: string;
      threadId: string;
      artifacts: ExecArtifactPaths;
    }
  | {
      id: string;
      type: "thread";
      threadId: string;
    };

type GraphEdge = {
  type: "dependsOn" | "invokes" | "resume" | "spawn" | "interact";
  from: string;
  to: string;
  callId?: string;
  status?: string;
  prompt?: string;
  source?: "workflow" | "resume" | "transcript";
};

type RunManifest = {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  cwd: string;
  options?: Record<string, unknown>;
  execs: ExecManifestEntry[];
  graph?: {
    nodes: GraphNode[];
    edges: GraphEdge[];
    warnings?: string[];
  };
};

type Args = {
  port: number;
  host: string;
  codexHome: string;
};

const DEFAULT_PORT = 4141;
const DEFAULT_HOST = "127.0.0.1";

const UI_INDEX_HTML = readFileSync(fileURLToPath(new URL("./run-viewer-ui/index.html", import.meta.url)), "utf8");
const UI_ASSETS = new Map<string, { contentType: string; body: Buffer }>([
  [
    "/assets/app.js",
    { contentType: "text/javascript; charset=utf-8", body: readFileSync(fileURLToPath(new URL("./run-viewer-ui/app.js", import.meta.url))) },
  ],
  [
    "/assets/styles.css",
    { contentType: "text/css; charset=utf-8", body: readFileSync(fileURLToPath(new URL("./run-viewer-ui/styles.css", import.meta.url))) },
  ],
  [
    "/assets/favicon.svg",
    { contentType: "image/svg+xml; charset=utf-8", body: readFileSync(fileURLToPath(new URL("./run-viewer-ui/favicon.svg", import.meta.url))) },
  ],
]);

if (isMainModule()) {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    printHelp();
    process.exit(1);
  }
  const baseDir = resolveBaseDir(process.cwd());
  const server = createRunViewerServer({ codexHome: args.codexHome, baseDir });
  server.listen(args.port, args.host, () => {
    const address = `http://${args.host}:${args.port}`;
    // eslint-disable-next-line no-console
    console.log(`Run viewer listening on ${address}`);
    // eslint-disable-next-line no-console
    console.log(`Runs dir: ${path.join(baseDir, "runs", "autopilot")}`);
    // eslint-disable-next-line no-console
    console.log(`Codex home: ${args.codexHome}`);
  });
}

export async function routeRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  codexHome: string,
  baseDir: string,
): Promise<void> {
  applySecurityHeaders(res);
  if (!req.url) {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;
  const segments = pathname.split("/").filter(Boolean);

  if (pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  const asset = UI_ASSETS.get(pathname);
  if (asset) {
    res.writeHead(200, { "content-type": asset.contentType });
    res.end(asset.body);
    return;
  }

  if (pathname === "/" || pathname === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderHtml());
    return;
  }

  if (segments.length === 2 && segments[0] === "api" && segments[1] === "runs") {
    await handleRunsList(res, baseDir);
    return;
  }

  if (segments.length === 4 && segments[0] === "api" && segments[1] === "runs" && segments[3] === "manifest") {
    const runId = segments[2];
    if (!isSafeRunId(runId)) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "invalid_run_id" }));
      return;
    }
    await handleManifest(res, baseDir, runId);
    return;
  }

  if (segments.length === 4 && segments[0] === "api" && segments[1] === "runs" && segments[3] === "file") {
    const runId = segments[2];
    if (!isSafeRunId(runId)) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "invalid_run_id" }));
      return;
    }
    const relPath = url.searchParams.get("path");
    if (!relPath) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "missing_path" }));
      return;
    }
    await handleRunFile(res, baseDir, runId, relPath);
    return;
  }

  if (segments.length === 3 && segments[0] === "api" && segments[1] === "transcript") {
    const threadId = segments[2];
    const metaOnly = url.searchParams.get("meta") === "1";
    await handleTranscript(res, threadId, codexHome, metaOnly);
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

export function isSafeRunId(runId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(runId);
}

export function parseArgs(argv: string[]): Args | null {
  let port = DEFAULT_PORT;
  let host = DEFAULT_HOST;
  let codexHome = path.join(os.homedir(), ".codex");

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      return null;
    }
    if (arg === "--port") {
      const next = argv[i + 1];
      if (!next) return null;
      port = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--host") {
      const next = argv[i + 1];
      if (!next) return null;
      host = next;
      i += 1;
      continue;
    }
    if (arg === "--codex-home") {
      const next = argv[i + 1];
      if (!next) return null;
      codexHome = next;
      i += 1;
      continue;
    }
    return null;
  }

  if (!Number.isFinite(port) || port <= 0) return null;
  return { port, host, codexHome };
}

export function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`Usage: node examples/run-viewer.ts [--port <port>] [--host <host>] [--codex-home <path>]`);
}

export function resolveBaseDir(startDir: string): string {
  let dir = startDir;
  while (true) {
    if (existsSync(path.join(dir, "runs", "autopilot"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}

export function renderHtml(): string {
  return UI_INDEX_HTML;
}

export async function handleRunsList(res: http.ServerResponse, baseDir: string): Promise<void> {
  const runsDir = path.join(baseDir, "runs", "autopilot");
  let entries: Array<{ runId: string; startedAt: string; finishedAt?: string }> = [];
  let dirents: Array<import("node:fs").Dirent> = [];
  try {
    dirents = await readdir(runsDir, { withFileTypes: true });
  } catch {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify([]));
    return;
  }
  await Promise.all(
    dirents.map(async (entry) => {
      if (!entry.isDirectory()) return;
      const runId = entry.name;
      const manifestPath = path.join(runsDir, runId, "manifest.json");
      try {
        const payload = JSON.parse(await readFile(manifestPath, "utf8")) as RunManifest;
        entries.push({ runId, startedAt: payload.startedAt, finishedAt: payload.finishedAt });
      } catch {
        return;
      }
    }),
  );
  entries = entries.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(entries));
}

export async function handleManifest(
  res: http.ServerResponse,
  baseDir: string,
  runId: string,
): Promise<void> {
  const manifestPath = path.join(baseDir, "runs", "autopilot", runId, "manifest.json");
  try {
    const payload = await readFile(manifestPath, "utf8");
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(payload);
  } catch {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "manifest_not_found" }));
  }
}

export async function handleRunFile(
  res: http.ServerResponse,
  baseDir: string,
  runId: string,
  relPath: string,
): Promise<void> {
  const runDir = path.join(baseDir, "runs", "autopilot", runId);
  if (path.isAbsolute(relPath)) {
    res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "invalid_path" }));
    return;
  }
  let normalizedRunDir: string;
  try {
    normalizedRunDir = await realpath(runDir);
  } catch {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "file_not_found" }));
    return;
  }
  const resolved = path.resolve(normalizedRunDir, relPath);
  if (!isWithin(normalizedRunDir, resolved)) {
    res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "invalid_path" }));
    return;
  }
  let realFilePath: string;
  try {
    realFilePath = await realpath(resolved);
  } catch {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "file_not_found" }));
    return;
  }
  if (!isWithin(normalizedRunDir, realFilePath)) {
    res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "invalid_path" }));
    return;
  }
  try {
    const stats = await stat(realFilePath);
    if (!stats.isFile()) {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "file_not_found" }));
      return;
    }
    const stream = createReadStream(realFilePath, { encoding: "utf8" });
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    stream.pipe(res);
    stream.on("error", () => {
      res.end();
    });
  } catch {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "file_not_found" }));
  }
}

export async function handleTranscript(
  res: http.ServerResponse,
  threadId: string,
  codexHome: string,
  metaOnly: boolean,
): Promise<void> {
  const transcriptPath = await findTranscriptPath(threadId, codexHome);
  if (!transcriptPath) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(`Transcript not found for thread ${threadId}.`);
    return;
  }
  if (metaOnly) {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ path: transcriptPath }));
    return;
  }
  try {
    const stats = await stat(transcriptPath);
    if (!stats.isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(`Transcript not found for thread ${threadId}.`);
      return;
    }
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(`Transcript not found for thread ${threadId}.`);
    return;
  }
  res.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "x-transcript-path": transcriptPath,
  });
  const stream = createReadStream(transcriptPath, { encoding: "utf8" });
  stream.pipe(res);
  stream.on("error", () => res.end());
}

export async function findTranscriptPath(threadId: string, codexHome: string): Promise<string | null> {
  const sessionsDir = path.join(codexHome, "sessions");
  let entries: Array<{ filePath: string; mtimeMs: number }> = [];

  const walk = async (dir: string): Promise<void> => {
    let dirEntries: Array<import("node:fs").Dirent>;
    try {
      dirEntries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      dirEntries.map(async (entry) => {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(entryPath);
          return;
        }
        if (!entry.isFile()) return;
        if (!entry.name.includes(`-${threadId}.jsonl`)) return;
        if (!entry.name.startsWith("rollout-")) return;
        try {
          const stats = await stat(entryPath);
          entries.push({ filePath: entryPath, mtimeMs: stats.mtimeMs });
        } catch {
          // ignore stat errors
        }
      }),
    );
  };

  await walk(sessionsDir);
  if (!entries.length) return null;
  entries = entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries[0].filePath;
}

export function createRunViewerServer(options: { codexHome: string; baseDir: string }): http.Server {
  return http.createServer(async (req, res) => {
    try {
      await routeRequest(req, res, options.codexHome, options.baseDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "internal_error", message }));
    }
  });
}

function applySecurityHeaders(res: http.ServerResponse): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("cross-origin-resource-policy", "same-origin");
  res.setHeader("cross-origin-opener-policy", "same-origin");
  res.setHeader(
    "content-security-policy",
    [
      "default-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
    ].join("; "),
  );
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(entry).href === import.meta.url;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  if (!relative || relative === "") return false;
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}
