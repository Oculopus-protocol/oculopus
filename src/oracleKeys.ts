// API-key store for the paid oracle: a keyed caller gets a monthly free quota; keyless
// callers (or once the quota is spent) fall through to pay-per-call over x402. A tiny
// SQLite table — the oracle reads it in onProtectedRequest, `npm run key:create` writes it.
//
// The quota belongs to the WALLET, not the key, and its size comes from the wallet's tier
// (see plans.ts). Tier is stored here and refreshed at sign-in so the hot path stays a
// local read — no upstream call per request.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { PLANS, type Tier } from "./plans.js";

const DB_PATH = process.env.ORACLE_DB ?? "data-oracle/keys.db";
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS api_keys(
  key TEXT PRIMARY KEY, label TEXT, created_at INTEGER,
  month TEXT, used INTEGER DEFAULT 0, monthly_limit INTEGER DEFAULT 10000, owner TEXT
)`);
// Migrate older DBs that predate the owner column (a key belongs to the wallet that made it).
try { db.exec("ALTER TABLE api_keys ADD COLUMN owner TEXT"); } catch { /* already present */ }
// consumeKey sums a wallet's usage on every request; without this it is a table scan that
// gets slower the more keys exist — which is itself an abuse vector.
db.exec("CREATE INDEX IF NOT EXISTS idx_api_keys_owner_month ON api_keys(owner, month)");
// A wallet's earned tier. Refreshed at sign-in; the request path only reads it.
db.exec(`CREATE TABLE IF NOT EXISTS key_owners(
  owner TEXT PRIMARY KEY, tier TEXT NOT NULL, monthly_quota INTEGER NOT NULL, updated_at INTEGER
)`);
// Session tokens are stateless HMACs, so the only way to kill one early is to refuse every
// token issued before a cut-off. Per wallet, so one compromised token does not force a
// global secret rotation that signs everybody out.
try { db.exec("ALTER TABLE key_owners ADD COLUMN signed_out_before INTEGER DEFAULT 0"); } catch { /* already present */ }
// Paid calls per wallet per month — the ledger the free tier is earned from. Kept apart
// from api_keys because it survives key rotation: a wallet's spending history should not
// reset because it revoked a key.
db.exec(`CREATE TABLE IF NOT EXISTS paid_usage(
  owner TEXT NOT NULL, month TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner, month)
)`);

/** Legacy CLI keys (owner NULL) keep their own per-key limit. */
const FREE_LIMIT = Number(process.env.ORACLE_FREE_LIMIT ?? PLANS.verified.monthlyQuota);
/** Cap on keys per wallet. Unbounded minting bloats the table and slows every lookup. */
export const MAX_KEYS_PER_OWNER = Number(process.env.ORACLE_MAX_KEYS_PER_OWNER ?? 10);

const ym = (): string => new Date().toISOString().slice(0, 7); // YYYY-MM

/** Record (or refresh) a wallet's tier and the quota that comes with it. */
export function setOwnerTier(owner: string, tier: Tier): void {
  db.prepare(
    `INSERT INTO key_owners(owner,tier,monthly_quota,updated_at) VALUES(?,?,?,?)
     ON CONFLICT(owner) DO UPDATE SET tier=excluded.tier, monthly_quota=excluded.monthly_quota, updated_at=excluded.updated_at`,
  ).run(owner.toLowerCase(), tier, PLANS[tier].monthlyQuota, Date.now());
}

export interface OwnerPlan { tier: Tier; monthlyQuota: number }

export function ownerPlan(owner: string): OwnerPlan {
  const row = db.prepare("SELECT tier, monthly_quota FROM key_owners WHERE owner=?").get(owner.toLowerCase()) as
    | { tier: Tier; monthly_quota: number }
    | undefined;
  return row ? { tier: row.tier, monthlyQuota: row.monthly_quota } : { tier: "unverified", monthlyQuota: PLANS.unverified.monthlyQuota };
}

/** Create a key with a monthly free quota. Returned once — the caller stores it. */
export function mintKey(label = "default", limit = FREE_LIMIT): string {
  const key = "oc_live_" + randomBytes(18).toString("hex");
  db.prepare("INSERT INTO api_keys(key,label,created_at,month,used,monthly_limit) VALUES(?,?,?,?,0,?)")
    .run(key, label, Date.now(), ym(), limit);
  return key;
}

export interface ConsumeResult {
  /** true → serve free; false → fall through to x402 payment. */
  ok: boolean;
  tier: Tier | null;
  quota: number;
  remaining: number;
}

const MISS: ConsumeResult = { ok: false, tier: null, quota: 0, remaining: 0 };

/**
 * Count one free read against a key, atomically.
 *
 * The read of the running total and the increment run in ONE transaction: done as two
 * statements, two concurrent requests both read `used = quota - 1`, both pass, and the
 * quota is overrun. better-sqlite3 is synchronous, so the transaction is the whole fix.
 *
 * The month rolls over automatically.
 */
export const consumeKey = db.transaction((key: string | null | undefined): ConsumeResult => {
  if (!key) return MISS;
  const row = db.prepare("SELECT owner, month, used, monthly_limit FROM api_keys WHERE key=?").get(key) as
    | { owner: string | null; month: string; used: number; monthly_limit: number }
    | undefined;
  if (!row) return MISS;

  const month = ym();
  if (row.month !== month) {
    db.prepare("UPDATE api_keys SET month=?, used=0 WHERE key=?").run(month, key);
    row.used = 0;
  }

  if (row.owner) {
    // The free quota is per WALLET, not per key — minting extra keys must not multiply it.
    const plan = ownerPlan(row.owner);
    const { total } = db.prepare(
      "SELECT COALESCE(SUM(used),0) AS total FROM api_keys WHERE owner=? AND month=?",
    ).get(row.owner, month) as { total: number };
    if (total >= plan.monthlyQuota) return { ok: false, tier: plan.tier, quota: plan.monthlyQuota, remaining: 0 };
    db.prepare("UPDATE api_keys SET used = used + 1 WHERE key=?").run(key);
    return { ok: true, tier: plan.tier, quota: plan.monthlyQuota, remaining: plan.monthlyQuota - total - 1 };
  }

  // Keyless admin keys minted by the CLI keep their own per-key limit.
  if (row.used >= row.monthly_limit) return { ok: false, tier: null, quota: row.monthly_limit, remaining: 0 };
  db.prepare("UPDATE api_keys SET used = used + 1 WHERE key=?").run(key);
  return { ok: true, tier: null, quota: row.monthly_limit, remaining: row.monthly_limit - row.used - 1 };
}) as (key: string | null | undefined) => ConsumeResult;

export interface KeyRow { key: string; label: string; created_at: number; used: number; monthly_limit: number }

/** How many keys this wallet already holds. */
export function countKeysOf(owner: string): number {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE owner=?").get(owner.toLowerCase()) as { n: number };
  return n;
}

/** Mint a key owned by a wallet address (from the dashboard, after sign-in). */
export function mintKeyFor(owner: string, label = "key", limit = FREE_LIMIT): string {
  const key = "oc_live_" + randomBytes(18).toString("hex");
  db.prepare("INSERT INTO api_keys(key,label,created_at,month,used,monthly_limit,owner) VALUES(?,?,?,?,0,?,?)")
    .run(key, label, Date.now(), ym(), limit, owner.toLowerCase());
  return key;
}

/** Every key a wallet owns, with this month's usage. */
export function keysOf(owner: string): KeyRow[] {
  return db.prepare(
    "SELECT key,label,created_at,used,monthly_limit FROM api_keys WHERE owner=? ORDER BY created_at DESC",
  ).all(owner.toLowerCase()) as KeyRow[];
}

/** This month's total usage across every key the wallet owns. */
export function usageOf(owner: string): number {
  const { total } = db.prepare(
    "SELECT COALESCE(SUM(used),0) AS total FROM api_keys WHERE owner=? AND month=?",
  ).get(owner.toLowerCase(), ym()) as { total: number };
  return total;
}

/** Delete a key, but only if it belongs to this owner. */
export function revokeKey(owner: string, key: string): boolean {
  return db.prepare("DELETE FROM api_keys WHERE key=? AND owner=?").run(key, owner.toLowerCase()).changes > 0;
}

/** The calendar month before `ref` (default: now), as YYYY-MM. */
export function previousMonth(ref = new Date()): string {
  const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}

/** Which wallet a key belongs to, or null for a CLI-minted key. */
export function ownerOfKey(key: string): string | null {
  const row = db.prepare("SELECT owner FROM api_keys WHERE key=?").get(key) as { owner: string | null } | undefined;
  return row?.owner ?? null;
}

/**
 * Count one PAID call against a wallet.
 *
 * Only ever called once payment has actually settled. Counting an attempted-but-unpaid call
 * would hand an attacker the tier ladder for free: fire requests, never pay, rank up.
 */
export function recordPaidCall(owner: string, at = new Date()): void {
  db.prepare(
    `INSERT INTO paid_usage(owner,month,calls) VALUES(?,?,1)
     ON CONFLICT(owner,month) DO UPDATE SET calls = calls + 1`,
  ).run(owner.toLowerCase(), at.toISOString().slice(0, 7));
}

/** Paid calls a wallet made in a given month (defaults to the current one). */
export function paidCallsIn(owner: string, month = ym()): number {
  const row = db.prepare("SELECT calls FROM paid_usage WHERE owner=? AND month=?").get(owner.toLowerCase(), month) as
    | { calls: number }
    | undefined;
  return row?.calls ?? 0;
}

/** Invalidate every session token this wallet holds — "sign out everywhere". */
export function signOutAll(owner: string): void {
  db.prepare(
    `INSERT INTO key_owners(owner,tier,monthly_quota,updated_at,signed_out_before) VALUES(?,?,?,?,?)
     ON CONFLICT(owner) DO UPDATE SET signed_out_before=excluded.signed_out_before`,
  ).run(owner.toLowerCase(), "unverified", PLANS.unverified.monthlyQuota, Date.now(), Date.now());
}

/** Tokens issued before this ms timestamp are refused. 0 when the wallet never signed out. */
export function signedOutBefore(owner: string): number {
  const row = db.prepare("SELECT signed_out_before FROM key_owners WHERE owner=?").get(owner.toLowerCase()) as
    | { signed_out_before: number | null }
    | undefined;
  return row?.signed_out_before ?? 0;
}
