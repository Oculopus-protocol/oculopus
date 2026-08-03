// SQLite store — the durable, queryable backbone for a production Oculopus deployment.
//
// state.json (one in-memory blob) is fine for a single demo node; a real directory and
// analytics platform needs rows it can query and a store that need not fit in RAM. This
// is that store: one better-sqlite3 database, written as the node indexes and read by
// the API and (later) the scorer. Plain SQL, no ORM — the schema IS the data model.
//
// The DB is a cache/index, never a source of truth: everything here is re-derivable from
// chain, so deleting it forces a re-index and loses nothing unique. `doc_json` on a
// receipt is the one off-chain payload (the co-signed document POSTed to the node); it
// is what a gossip/DA layer would replicate between nodes later.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- owner -> ERC-8004 identity, indexed from Registered events. The complete map is what
-- lets any agent resolve its agentId regardless of how long ago it registered.
CREATE TABLE IF NOT EXISTS agent_ids (
  owner     TEXT PRIMARY KEY,
  agent_id  TEXT NOT NULL,
  agent_uri TEXT,
  block     INTEGER
);

CREATE TABLE IF NOT EXISTS agents (
  address          TEXT PRIMARY KEY,
  agent_id         TEXT,
  service_tag      INTEGER NOT NULL,
  metadata_uri     TEXT NOT NULL,
  registered_at    INTEGER NOT NULL,
  erc8004_json     TEXT,
  validations_json TEXT
);

CREATE TABLE IF NOT EXISTS receipts (
  hash            TEXT PRIMARY KEY,
  buyer           TEXT NOT NULL,
  provider        TEXT NOT NULL,
  service         TEXT NOT NULL,
  usdc            TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  delivered_at    INTEGER NOT NULL,
  received_at     INTEGER NOT NULL,
  verified        INTEGER NOT NULL DEFAULT 0,
  block           INTEGER,
  tx              TEXT,
  witnessed       INTEGER NOT NULL DEFAULT 0,
  provider_signed INTEGER NOT NULL DEFAULT 0,
  latency         INTEGER,
  disputed        INTEGER NOT NULL DEFAULT 0,
  requested_at    INTEGER,
  doc_json        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS receipts_provider  ON receipts(provider);
CREATE INDEX IF NOT EXISTS receipts_buyer     ON receipts(buyer);
CREATE INDEX IF NOT EXISTS receipts_verified  ON receipts(verified);
CREATE INDEX IF NOT EXISTS receipts_service   ON receipts(service);
CREATE INDEX IF NOT EXISTS receipts_delivered ON receipts(delivered_at);

CREATE TABLE IF NOT EXISTS jobs (
  job_id                TEXT PRIMARY KEY,
  provider              TEXT NOT NULL,
  client                TEXT NOT NULL,
  evaluator             TEXT NOT NULL,
  usdc                  TEXT,
  outcome               TEXT NOT NULL,
  independent_evaluator INTEGER NOT NULL DEFAULT 0,
  settled_at            INTEGER NOT NULL,
  tx                    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_provider ON jobs(provider);
`;

export interface AgentIdRow { owner: string; agent_id: string; agent_uri: string | null; block: number | null; }
export interface AgentRow {
  address: string; agent_id: string | null; service_tag: number; metadata_uri: string;
  registered_at: number; erc8004_json: string | null; validations_json: string | null;
}
export interface ReceiptRow {
  hash: string; buyer: string; provider: string; service: string; usdc: string; outcome: string;
  delivered_at: number; received_at: number; verified: number; block: number | null; tx: string | null;
  witnessed: number; provider_signed: number; latency: number | null; disputed: number; requested_at: number | null; doc_json: string;
}
export interface JobRow {
  job_id: string; provider: string; client: string; evaluator: string; usdc: string | null;
  outcome: string; independent_evaluator: number; settled_at: number; tx: string;
}

/** better-sqlite3 binds no booleans — normalise to 0/1. */
const bit = (v: boolean | undefined): number => (v ? 1 : 0);

export function openStore(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");   // API readers never block the indexer's writes
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);

  // Migrate older DBs: add the analytics columns if missing (SLA/response-time, dispute
  // history, discovery). ALTER ADD COLUMN is cheap; syncStateToStore repopulates them.
  const cols = new Set((db.prepare("PRAGMA table_info(receipts)").all() as { name: string }[]).map((c) => c.name));
  for (const [col, decl] of [["latency", "INTEGER"], ["disputed", "INTEGER NOT NULL DEFAULT 0"], ["requested_at", "INTEGER"]] as const) {
    if (!cols.has(col)) db.exec(`ALTER TABLE receipts ADD COLUMN ${col} ${decl}`);
  }

  const q = {
    getMeta: db.prepare("SELECT value FROM meta WHERE key = ?"),
    setMeta: db.prepare("INSERT INTO meta(key,value) VALUES(@key,@value) ON CONFLICT(key) DO UPDATE SET value=excluded.value"),

    putAgentId: db.prepare("INSERT INTO agent_ids(owner,agent_id,agent_uri,block) VALUES(@owner,@agent_id,@agent_uri,@block) ON CONFLICT(owner) DO UPDATE SET agent_id=excluded.agent_id, agent_uri=excluded.agent_uri, block=excluded.block"),
    getAgentId: db.prepare("SELECT * FROM agent_ids WHERE owner = ?"),

    putAgent: db.prepare("INSERT INTO agents(address,agent_id,service_tag,metadata_uri,registered_at,erc8004_json,validations_json) VALUES(@address,@agent_id,@service_tag,@metadata_uri,@registered_at,@erc8004_json,@validations_json) ON CONFLICT(address) DO UPDATE SET agent_id=excluded.agent_id, service_tag=excluded.service_tag, metadata_uri=excluded.metadata_uri, erc8004_json=excluded.erc8004_json, validations_json=excluded.validations_json"),
    getAgent: db.prepare("SELECT * FROM agents WHERE address = ?"),
    allAgents: db.prepare("SELECT * FROM agents"),

    putReceipt: db.prepare("INSERT INTO receipts(hash,buyer,provider,service,usdc,outcome,delivered_at,received_at,verified,block,tx,witnessed,provider_signed,latency,disputed,requested_at,doc_json) VALUES(@hash,@buyer,@provider,@service,@usdc,@outcome,@delivered_at,@received_at,@verified,@block,@tx,@witnessed,@provider_signed,@latency,@disputed,@requested_at,@doc_json) ON CONFLICT(hash) DO UPDATE SET verified=excluded.verified, block=excluded.block, tx=excluded.tx, witnessed=excluded.witnessed, provider_signed=excluded.provider_signed, latency=excluded.latency, disputed=excluded.disputed, requested_at=excluded.requested_at"),
    getReceipt: db.prepare("SELECT * FROM receipts WHERE hash = ?"),
    verifiedReceipts: db.prepare("SELECT * FROM receipts WHERE verified = 1"),
    receiptsByProvider: db.prepare("SELECT * FROM receipts WHERE provider = ? AND verified = 1 ORDER BY delivered_at DESC"),

    putJob: db.prepare("INSERT INTO jobs(job_id,provider,client,evaluator,usdc,outcome,independent_evaluator,settled_at,tx) VALUES(@job_id,@provider,@client,@evaluator,@usdc,@outcome,@independent_evaluator,@settled_at,@tx) ON CONFLICT(job_id) DO NOTHING"),
    hasJob: db.prepare("SELECT 1 FROM jobs WHERE job_id = ?"),
    allJobs: db.prepare("SELECT * FROM jobs"),

    counts: db.prepare("SELECT (SELECT COUNT(*) FROM agents) AS agents, (SELECT COUNT(*) FROM receipts) AS receipts, (SELECT COUNT(*) FROM receipts WHERE verified=1) AS verified, (SELECT COUNT(*) FROM jobs) AS jobs, (SELECT COUNT(*) FROM agent_ids) AS agent_ids"),
  };

  return {
    db,

    // -- cursors + scalars (lastBlock, jobsLastBlock, …) -------------------------------
    getMeta(key: string): string | undefined { return (q.getMeta.get(key) as { value: string } | undefined)?.value; },
    setMeta(key: string, value: string): void { q.setMeta.run({ key, value }); },
    getNumber(key: string, fallback: number): number { const v = this.getMeta(key); return v === undefined ? fallback : Number(v); },
    setNumber(key: string, value: number): void { this.setMeta(key, String(value)); },

    // -- ERC-8004 identity map --------------------------------------------------------
    putAgentId(owner: string, agentId: string, agentURI: string | null, block: number | null): void {
      q.putAgentId.run({ owner: owner.toLowerCase(), agent_id: agentId, agent_uri: agentURI, block });
    },
    getAgentId(owner: string): AgentIdRow | undefined { return q.getAgentId.get(owner.toLowerCase()) as AgentIdRow | undefined; },

    // -- directory listings -----------------------------------------------------------
    putAgent(a: { address: string; agentId?: string | null; serviceTag: number; metadataURI: string; registeredAt: number; erc8004?: unknown; validations?: unknown }): void {
      q.putAgent.run({
        address: a.address.toLowerCase(), agent_id: a.agentId ?? null, service_tag: a.serviceTag,
        metadata_uri: a.metadataURI, registered_at: a.registeredAt,
        erc8004_json: a.erc8004 ? JSON.stringify(a.erc8004) : null,
        validations_json: a.validations ? JSON.stringify(a.validations) : null,
      });
    },
    getAgent(address: string): AgentRow | undefined { return q.getAgent.get(address.toLowerCase()) as AgentRow | undefined; },
    allAgents(): AgentRow[] { return q.allAgents.all() as AgentRow[]; },

    // -- receipts ---------------------------------------------------------------------
    putReceipt(r: { hash: string; buyer: string; provider: string; service: string; usdc: string; outcome: string; deliveredAt: number; receivedAt: number; verified?: boolean; block?: number | null; tx?: string | null; witnessed?: boolean; providerSigned?: boolean; latency?: number | null; disputed?: boolean; requestedAt?: number | null; docJson: string }): void {
      q.putReceipt.run({
        hash: r.hash, buyer: r.buyer.toLowerCase(), provider: r.provider.toLowerCase(), service: r.service,
        usdc: r.usdc, outcome: r.outcome, delivered_at: r.deliveredAt, received_at: r.receivedAt,
        verified: bit(r.verified), block: r.block ?? null, tx: r.tx ?? null,
        witnessed: bit(r.witnessed), provider_signed: bit(r.providerSigned),
        latency: r.latency ?? null, disputed: bit(r.disputed), requested_at: r.requestedAt ?? null, doc_json: r.docJson,
      });
    },
    getReceipt(hash: string): ReceiptRow | undefined { return q.getReceipt.get(hash) as ReceiptRow | undefined; },
    verifiedReceipts(): ReceiptRow[] { return q.verifiedReceipts.all() as ReceiptRow[]; },
    receiptsByProvider(provider: string): ReceiptRow[] { return q.receiptsByProvider.all(provider.toLowerCase()) as ReceiptRow[]; },

    // -- jobs -------------------------------------------------------------------------
    putJob(j: { jobId: string; provider: string; client: string; evaluator: string; usdc?: string | null; outcome: string; independentEvaluator?: boolean; settledAt: number; tx: string }): void {
      q.putJob.run({
        job_id: j.jobId, provider: j.provider.toLowerCase(), client: j.client.toLowerCase(), evaluator: j.evaluator.toLowerCase(),
        usdc: j.usdc ?? null, outcome: j.outcome, independent_evaluator: bit(j.independentEvaluator), settled_at: j.settledAt, tx: j.tx,
      });
    },
    hasJob(jobId: string): boolean { return q.hasJob.get(jobId) !== undefined; },
    allJobs(): JobRow[] { return q.allJobs.all() as JobRow[]; },

    // -- analytics smoke ---------------------------------------------------------------
    counts(): { agents: number; receipts: number; verified: number; jobs: number; agent_ids: number } {
      return q.counts.get() as { agents: number; receipts: number; verified: number; jobs: number; agent_ids: number };
    },
  };
}

export type Store = ReturnType<typeof openStore>;
