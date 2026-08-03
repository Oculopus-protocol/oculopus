import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";
import { openStore } from "./store.js";

test("meta scalars round-trip", () => {
  const s = openStore(":memory:");
  assert.equal(s.getNumber("lastBlock", 0), 0); // fallback when absent
  s.setNumber("lastBlock", 12345);
  assert.equal(s.getNumber("lastBlock", 0), 12345);
  s.setMeta("k", "v");
  assert.equal(s.getMeta("k"), "v");
  s.db.close();
});

test("agent_ids resolve case-insensitively", () => {
  const s = openStore(":memory:");
  s.putAgentId("0xAbC", "77", "https://x", 100);
  assert.deepEqual(s.getAgentId("0xabc"), { owner: "0xabc", agent_id: "77", agent_uri: "https://x", block: 100 });
  assert.equal(s.getAgentId("0xnope"), undefined);
  s.db.close();
});

test("agent listing + erc8004 json round-trip", () => {
  const s = openStore(":memory:");
  s.putAgent({ address: "0xAA", agentId: "1", serviceTag: 3, metadataURI: "u", registeredAt: 5, erc8004: { clients: 2, feedback: 8, rawScore: 70 } });
  const a = s.getAgent("0xaa")!;
  assert.equal(a.agent_id, "1");
  assert.equal(a.service_tag, 3);
  assert.deepEqual(JSON.parse(a.erc8004_json!), { clients: 2, feedback: 8, rawScore: 70 });
  assert.equal(a.validations_json, null);
  assert.equal(s.allAgents().length, 1);
  s.db.close();
});

test("receipts: verified-only reads, DESC sort, analytics columns", () => {
  const s = openStore(":memory:");
  const base = { buyer: "0xB", service: "embedding", usdc: "1", outcome: "success", receivedAt: 1, docJson: "{}" };
  s.putReceipt({ ...base, hash: "0xr1", provider: "0xP", deliveredAt: 100, verified: true, block: 1, tx: "0xt1", providerSigned: true, latency: 250, disputed: false, requestedAt: 90 });
  s.putReceipt({ ...base, hash: "0xr2", provider: "0xP", deliveredAt: 200, verified: true, block: 2, tx: "0xt2", providerSigned: true });
  s.putReceipt({ ...base, hash: "0xr3", provider: "0xP", deliveredAt: 300, verified: false }); // unverified — excluded

  assert.equal(s.verifiedReceipts().length, 2);
  const byProvider = s.receiptsByProvider("0xp"); // lowercased lookup
  assert.equal(byProvider.length, 2);
  assert.equal(byProvider[0]!.hash, "0xr2", "sorted delivered_at DESC");

  const r1 = s.getReceipt("0xr1")!;
  assert.equal(r1.latency, 250);
  assert.equal(r1.disputed, 0);
  assert.equal(r1.requested_at, 90);
  const r2 = s.getReceipt("0xr2")!;
  assert.equal(r2.latency, null); // absent -> null
  assert.equal(r2.requested_at, null);
  s.db.close();
});

test("receipt upsert promotes an unverified row to verified", () => {
  const s = openStore(":memory:");
  const r = { hash: "0xh", buyer: "0xB", provider: "0xP", service: "s", usdc: "1", outcome: "success", deliveredAt: 1, receivedAt: 1, docJson: "{}" };
  s.putReceipt({ ...r, verified: false });
  assert.equal(s.verifiedReceipts().length, 0);
  s.putReceipt({ ...r, verified: true, block: 9, tx: "0xt", providerSigned: true, disputed: true });
  assert.equal(s.verifiedReceipts().length, 1);
  assert.equal(s.getReceipt("0xh")!.disputed, 1);
  s.db.close();
});

test("jobs insert once (ON CONFLICT DO NOTHING)", () => {
  const s = openStore(":memory:");
  s.putJob({ jobId: "j1", provider: "0xP", client: "0xC", evaluator: "0xE", usdc: "1", outcome: "success", independentEvaluator: true, settledAt: 1, tx: "0xt" });
  s.putJob({ jobId: "j1", provider: "0xP", client: "0xC", evaluator: "0xE", usdc: "999", outcome: "fail", settledAt: 2, tx: "0xt2" });
  assert.equal(s.hasJob("j1"), true);
  assert.equal(s.hasJob("nope"), false);
  const jobs = s.allJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.usdc, "1", "first write wins");
  assert.equal(jobs[0]!.independent_evaluator, 1);
  s.db.close();
});

test("counts across tables", () => {
  const s = openStore(":memory:");
  s.putAgent({ address: "0xA", serviceTag: 1, metadataURI: "u", registeredAt: 1 });
  s.putAgentId("0xA", "1", null, 1);
  s.putReceipt({ hash: "0xr", buyer: "0xB", provider: "0xA", service: "s", usdc: "1", outcome: "success", deliveredAt: 1, receivedAt: 1, verified: true, docJson: "{}" });
  s.putJob({ jobId: "j", provider: "0xA", client: "0xC", evaluator: "0xE", outcome: "success", settledAt: 1, tx: "0xt" });
  assert.deepEqual(s.counts(), { agents: 1, receipts: 1, verified: 1, jobs: 1, agent_ids: 1 });
  s.db.close();
});

test("migration adds analytics columns to an older DB, preserving rows", () => {
  const p = join(tmpdir(), `ocu-store-test-${process.pid}-${Date.now()}.db`);
  try {
    // a receipts table as it existed before the latency/disputed/requested_at columns
    const old = new Database(p);
    old.exec("CREATE TABLE receipts(hash TEXT PRIMARY KEY, buyer TEXT, provider TEXT, service TEXT, usdc TEXT, outcome TEXT, delivered_at INTEGER, received_at INTEGER, verified INTEGER, block INTEGER, tx TEXT, witnessed INTEGER, provider_signed INTEGER, doc_json TEXT)");
    old.prepare("INSERT INTO receipts(hash,buyer,provider,service,usdc,outcome,delivered_at,received_at,verified,witnessed,provider_signed,doc_json) VALUES('0xold','0xb','0xa','ocr','2','fail',10,5,1,0,0,'{}')").run();
    old.close();

    const s = openStore(p); // must ALTER-add the new columns without dropping data
    const cols = (s.db.prepare("PRAGMA table_info(receipts)").all() as { name: string }[]).map((c) => c.name);
    for (const c of ["latency", "disputed", "requested_at"]) assert.ok(cols.includes(c), `column ${c} added`);
    assert.ok(s.getReceipt("0xold"), "existing row preserved");
    s.db.close();
  } finally {
    for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true });
  }
});
