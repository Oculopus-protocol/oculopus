// HTTP contract tests for the node's public API.
//
// The other suites test pure functions. This one starts the real server in a child process
// and talks to it over HTTP, because the things that break in production are the things
// only the wire shows: a status code that changed, a field that quietly disappeared from a
// response, a body cap that stopped applying. A 413 that never arrives because the socket
// was destroyed before the response was written type-checks perfectly.
//
// The node is pointed at a dead RPC on purpose. Indexing is fire-and-forget, so the HTTP
// surface comes up regardless, and the tests stay hermetic — no network, no live chain, and
// the same result on a laptop as in CI.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8800 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = mkdtempSync(join(tmpdir(), "oculopus-api-"));
const BODY_CAP = 1024;

let child: ChildProcess | undefined;

const get = (path: string, init?: RequestInit): Promise<Response> =>
  fetch(BASE + path, { signal: AbortSignal.timeout(8000), ...init });

before(async () => {
  child = spawn("npx", ["tsx", "src/node.ts"], {
    env: {
      ...process.env,
      NODE_PORT: String(PORT),
      OCULOPUS_STATE_DIR: STATE,
      // Unroutable: the indexer will fail every call, which is what we want.
      OCULOPUS_RPC_URLS: "http://127.0.0.1:1",
      OCULOPUS_MAX_BODY_BYTES: String(BODY_CAP),
      OCULOPUS_SCORES_TTL_MS: "0",
    },
    stdio: "ignore",
    shell: process.platform === "win32",
  });

  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/directory`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`node did not start on ${BASE} within 60s`);
    await new Promise((r) => setTimeout(r, 400));
  }
});

after(() => {
  if (child?.pid) {
    // child.kill() leaves the tsx grandchild running on Windows, which holds the port and
    // the SQLite file for the next run.
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  }
  try { rmSync(STATE, { recursive: true, force: true }); } catch { /* best effort */ }
});

test("the public read endpoints answer with the shape clients parse", async () => {
  const dir = await get("/directory");
  assert.equal(dir.status, 200);
  assert.match(dir.headers.get("content-type") ?? "", /application\/json/);
  const dirBody = (await dir.json()) as { agents?: unknown };
  assert.ok(Array.isArray(dirBody.agents), "/directory must always carry an agents array");

  const buyers = await get("/buyers");
  assert.equal(buyers.status, 200);
  assert.ok("buyers" in ((await buyers.json()) as object), "/buyers must carry a buyers field");

  const scores = await get("/scores");
  assert.equal(scores.status, 200);
  const s = (await scores.json()) as { providers?: unknown; buyers?: unknown; generatedAt?: unknown };
  for (const field of ["providers", "buyers", "generatedAt"] as const) {
    assert.ok(s[field] !== undefined, `/scores must carry ${field}`);
  }
});

test("an unknown agent is a 404, not an empty 200", async () => {
  // A caller must be able to tell "no such agent" from "an agent with no activity".
  const r = await get("/agents/0x0000000000000000000000000000000000000001");
  assert.equal(r.status, 404);
});

test("an unknown route is a 404", async () => {
  assert.equal((await get("/definitely-not-a-route")).status, 404);
});

test("the agent-card schema is served for anyone validating a card", async () => {
  const r = await get("/agent-card/scheme");
  assert.equal(r.status, 200);
  assert.ok((await r.json()) !== null);
});

test("CORS is open on the public reads", async () => {
  // The dashboard and third-party explorers call these cross-origin. Auth is a bearer
  // token rather than a cookie, so a wildcard origin is safe here.
  const r = await get("/directory");
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
});

test("a malformed receipt is rejected with 400, not a 500", async () => {
  const r = await get("/receipts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nope: 1 }),
  });
  assert.equal(r.status, 400, "garbage in must be a client error, never a server error");
});

test("an oversized body is refused with 413 and the response actually arrives", async () => {
  // This is the regression that unit tests could not have caught. The first version of the
  // cap destroyed the socket before writing the response, so the client saw a connection
  // reset instead of a 413 — the check worked and the answer never got out.
  const r = await get("/receipts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pad: "x".repeat(BODY_CAP * 4) }),
  });
  assert.equal(r.status, 413);
  const body = (await r.json()) as { error?: string };
  assert.match(body.error ?? "", /exceeds/, "the 413 should say what limit was hit");
});

test("the server survives an oversized body and keeps serving", async () => {
  // A rejected request must not take the node with it.
  const r = await get("/directory");
  assert.equal(r.status, 200, "node must still answer after refusing a large body");
});
