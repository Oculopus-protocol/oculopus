// Token-bucket rate limiting, in-memory and dependency-free (same reasoning as the HMAC
// session tokens: one small file beats another dependency on a public surface).
//
// Layer 3 of the defence stack — it shapes a single key or wallet. Volumetric floods are
// layers 1 and 2 (Cloudflare, then nginx limit_req per IP); the monthly quota in
// oracleKeys.ts is layer 4. A bucket alone cannot stop a distributed flood and is not
// meant to: it stops one caller from draining a month of quota in forty seconds.
//
// The table is bounded. An unbounded Map keyed by caller-controlled input is exactly the
// bug this module exists to prevent, so entries are swept on a timer and the table is
// capped; when it is full the oldest idle bucket is dropped.

interface Bucket {
  tokens: number;
  /** ms epoch of the last refill — also serves as the idle clock for eviction. */
  last: number;
}

const MAX_BUCKETS = Number(process.env.ORACLE_MAX_BUCKETS ?? 50_000);
const IDLE_MS = Number(process.env.ORACLE_BUCKET_IDLE_MS ?? 10 * 60_000);

const buckets = new Map<string, Bucket>();

/** Drop buckets nobody has touched for IDLE_MS. A full bucket is indistinguishable from a
 *  missing one, so evicting an idle caller never hands out extra allowance. */
function sweep(now: number): void {
  for (const [k, b] of buckets) if (now - b.last > IDLE_MS) buckets.delete(k);
}

let lastSweep = 0;

export interface RateResult {
  ok: boolean;
  /** Whole tokens left in the bucket, for the X-RateLimit-Remaining header. */
  remaining: number;
  /** Seconds until one token is available again — only meaningful when ok is false. */
  retryAfter: number;
}

/**
 * Spend one token from `key`'s bucket.
 *
 * @param ratePerSec sustained refill rate
 * @param burst      bucket depth; a fresh caller may spend this many before throttling
 */
export function take(key: string, ratePerSec: number, burst: number): RateResult {
  const now = Date.now();

  // Amortised cleanup — at most once a minute, so a burst of traffic does not also pay
  // for a full scan on every request.
  if (now - lastSweep > 60_000) {
    sweep(now);
    lastSweep = now;
  }

  let b = buckets.get(key);
  if (!b) {
    if (buckets.size >= MAX_BUCKETS) {
      sweep(now);
      // Still full after sweeping: drop the least recently used entry. Map iterates in
      // insertion order and refills rewrite `last` but not the position, so scan for it.
      if (buckets.size >= MAX_BUCKETS) {
        let oldestKey: string | null = null;
        let oldestAt = Infinity;
        for (const [k, v] of buckets) {
          if (v.last < oldestAt) { oldestAt = v.last; oldestKey = k; }
        }
        if (oldestKey !== null) buckets.delete(oldestKey);
      }
    }
    b = { tokens: burst, last: now };
    buckets.set(key, b);
  } else {
    const refill = ((now - b.last) / 1000) * ratePerSec;
    b.tokens = Math.min(burst, b.tokens + refill);
    b.last = now;
  }

  if (b.tokens < 1) {
    return { ok: false, remaining: 0, retryAfter: Math.max(1, Math.ceil((1 - b.tokens) / ratePerSec)) };
  }
  b.tokens -= 1;
  return { ok: true, remaining: Math.floor(b.tokens), retryAfter: 0 };
}

/** Test seam — drops all state. */
export function resetLimiter(): void {
  buckets.clear();
  lastSweep = 0;
}

/** Current table size, for the abuse tests that assert the bound holds. */
export function bucketCount(): number {
  return buckets.size;
}
