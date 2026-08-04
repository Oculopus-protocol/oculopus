// API-key store for the paid oracle: a keyed caller gets a monthly free quota; keyless
// callers (or once the quota is spent) fall through to pay-per-call over x402. A tiny
// SQLite table — the oracle reads it in onProtectedRequest, `npm run key:create` writes it.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

const DB_PATH = process.env.ORACLE_DB ?? "data-oracle/keys.db";
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS api_keys(
  key TEXT PRIMARY KEY, label TEXT, created_at INTEGER,
  month TEXT, used INTEGER DEFAULT 0, monthly_limit INTEGER DEFAULT 10000
)`);

const FREE_LIMIT = Number(process.env.ORACLE_FREE_LIMIT ?? 10000);
const ym = (): string => new Date().toISOString().slice(0, 7); // YYYY-MM

/** Create a key with a monthly free quota. Returned once — the caller stores it. */
export function mintKey(label = "default", limit = FREE_LIMIT): string {
  const key = "oc_live_" + randomBytes(18).toString("hex");
  db.prepare("INSERT INTO api_keys(key,label,created_at,month,used,monthly_limit) VALUES(?,?,?,?,0,?)")
    .run(key, label, Date.now(), ym(), limit);
  return key;
}

/**
 * Count one free read against a key. Returns true (grant free access) when the key is
 * known and under its monthly quota; false (→ require x402 payment) when unknown or spent.
 * The month rolls over automatically.
 */
export function consumeKey(key: string | null | undefined): boolean {
  if (!key) return false;
  const row = db.prepare("SELECT month, used, monthly_limit FROM api_keys WHERE key=?").get(key) as
    | { month: string; used: number; monthly_limit: number }
    | undefined;
  if (!row) return false;
  const month = ym();
  if (row.month !== month) { db.prepare("UPDATE api_keys SET month=?, used=0 WHERE key=?").run(month, key); row.used = 0; }
  if (row.used >= row.monthly_limit) return false;
  db.prepare("UPDATE api_keys SET used = used + 1 WHERE key=?").run(key);
  return true;
}
