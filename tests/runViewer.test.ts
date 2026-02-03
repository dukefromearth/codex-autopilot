/**
 * Run viewer API + UI contract tests for the autopilot viewer.
 *
 * Business intent:
 * - Guard traversal handling, transcript lookup, and event stream abort logic in the run viewer.
 *
 * Gotchas:
 * - The viewer is an example; tests spin up a local server with a temp run root.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";

import { renderHtml, routeRequest } from "../examples/run-viewer";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "run-viewer-"));
  return await fn(dir);
}

class MockResponse extends Writable {
  statusCode = 200;
  headers: Record<string, string> = {};
  private chunks: Buffer[] = [];

  writeHead(statusCode: number, headers?: Record<string, string>): this {
    this.statusCode = statusCode;
    if (headers) {
      Object.assign(this.headers, headers);
    }
    return this;
  }

  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }

  bodyText(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

async function invokeRoute(
  url: string,
  baseDir: string,
  codexHome: string,
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  const req = { url, headers: { host: "localhost" } } as http.IncomingMessage;
  const res = new MockResponse() as unknown as http.ServerResponse & MockResponse;
  await routeRequest(req, res, codexHome, baseDir);
  if (!res.writableEnded) {
    await new Promise<void>((resolve) => res.on("finish", () => resolve()));
  }
  return { statusCode: res.statusCode, headers: res.headers, body: res.bodyText() };
}

test("run viewer rejects traversal and returns 404 for missing artifacts", async () => {
  await withTempDir(async (dir) => {
    const runDir = path.join(dir, "runs", "autopilot", "run-1");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, "manifest.json"),
      JSON.stringify({ runId: "run-1", startedAt: new Date().toISOString(), execs: [] }),
    );
    const traversal = await invokeRoute("/api/runs/run-1/file?path=../secret.txt", dir, dir);
    assert.equal(traversal.statusCode, 400);
    const secretPath = path.join(dir, "secret.txt");
    await writeFile(secretPath, "secret");
    await symlink(secretPath, path.join(runDir, "leak.txt"));
    const symlinkEscape = await invokeRoute("/api/runs/run-1/file?path=leak.txt", dir, dir);
    assert.equal(symlinkEscape.statusCode, 400);
    const strict = await invokeRoute("/api/runs/run-1/manifest/extra", dir, dir);
    assert.equal(strict.statusCode, 404);
    const missing = await invokeRoute("/api/runs/run-1/file?path=missing.txt", dir, dir);
    assert.equal(missing.statusCode, 404);
  });
});

test("run viewer transcript lookup uses --codex-home override", async () => {
  await withTempDir(async (dir) => {
    const codexHome = path.join(dir, "codex-home");
    const sessionsDir = path.join(codexHome, "sessions", "2026", "02", "03");
    await mkdir(sessionsDir, { recursive: true });
    const threadId = "thread-abc";
    const transcriptPath = path.join(sessionsDir, `rollout-xyz-${threadId}.jsonl`);
    await writeFile(transcriptPath, JSON.stringify({ type: "session_meta" }) + "\n");
    const meta = await invokeRoute(`/api/transcript/${threadId}?meta=1`, dir, codexHome);
    assert.equal(meta.statusCode, 200);
    const payload = JSON.parse(meta.body) as { path?: string };
    assert.equal(payload.path, transcriptPath);
    const transcript = await invokeRoute(`/api/transcript/${threadId}`, dir, codexHome);
    assert.equal(transcript.statusCode, 200);
    assert.ok(transcript.body.includes("session_meta"));
  });
});

test("run viewer HTML embeds abortable event reload logic", () => {
  const html = renderHtml();
  assert.ok(html.includes('rel="stylesheet"'));
  assert.ok(html.includes('src="/assets/app.js"'));
  assert.ok(html.includes('href="/assets/styles.css"'));
});

test("run viewer serves UI assets with expected client logic", async () => {
  await withTempDir(async (dir) => {
    const js = await invokeRoute("/assets/app.js", dir, dir);
    assert.equal(js.statusCode, 200);
    assert.ok(js.body.includes("AbortController"));
    assert.ok(js.body.includes("abortEventsStream"));
    assert.ok(js.body.includes("state.eventsAbortController.abort()"));
  });
});

test("run viewer client code does not contain a broken regex literal", async () => {
  await withTempDir(async (dir) => {
    const js = await invokeRoute("/assets/app.js", dir, dir);
    assert.equal(js.statusCode, 200);
    assert.equal(js.body.includes("promptText.replace(/\n"), false);
    assert.ok(js.body.includes("promptText.replace(/\\n/g"));
  });
});

test("run viewer sets security headers on HTML responses", async () => {
  await withTempDir(async (dir) => {
    const res = await invokeRoute("/", dir, dir);
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers["content-security-policy"]?.includes("default-src 'none'"));
    assert.ok(res.headers["content-security-policy"]?.includes("script-src 'self'"));
  });
});
