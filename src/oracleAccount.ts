// Dashboard account API for the paid oracle: sign in with a wallet (SIWE-style nonce +
// personal_sign), then create / list / revoke API keys owned by that wallet. Mounted under
// /oracle/account/* so it reuses the oracle's nginx route; these routes are NOT x402-gated.
//
// Auth is a plain HMAC session token (no extra deps): sign-in returns a token the dashboard
// sends as `Authorization: Bearer …`. Set ORACLE_SESSION_SECRET to keep tokens valid across
// restarts (otherwise a random per-boot secret is used).
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { recoverMessageAddress, type Hex } from "viem";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  keysOf,
  mintKeyFor,
  revokeKey,
  countKeysOf,
  ownerPlan,
  setOwnerTier,
  signOutAll,
  signedOutBefore,
  usageOf,
  paidCallsIn,
  previousMonth,
  MAX_KEYS_PER_OWNER,
} from "./oracleKeys.js";
import { PLANS, tierOf } from "./plans.js";
import { take } from "./rateLimit.js";

const SECRET_FROM_ENV = process.env.ORACLE_SESSION_SECRET;
const SECRET = SECRET_FROM_ENV ?? randomBytes(32).toString("hex");
if (!SECRET_FROM_ENV) {
  console.warn(
    "[oracle] ORACLE_SESSION_SECRET is not set — using a random per-boot secret, so every " +
      "restart signs all dashboard users out. Set it in .env before running in production.",
  );
}
const TOKEN_TTL_MS = 7 * 86_400_000;
const NONCE_TTL_MS = 5 * 60_000;
// The nonce endpoint is free and unauthenticated, so its table is caller-controlled and
// must be bounded. Expiry alone is not enough: nothing ever read the expired entries back
// out, so the map grew without limit under a loop of requests.
const MAX_NONCES = Number(process.env.ORACLE_MAX_NONCES ?? 20_000);
const nonces = new Map<string, number>(); // nonce -> expiry
const message = (nonce: string): string => `Sign in to Oculopus\n\nNonce: ${nonce}`;

function sweepNonces(): void {
  const now = Date.now();
  for (const [n, exp] of nonces) if (exp < now) nonces.delete(n);
}

function signToken(address: string): string {
  const body = Buffer.from(
    JSON.stringify({ address, iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS }),
  ).toString("base64url");
  return body + "." + createHmac("sha256", SECRET).update(body).digest("base64url");
}

function readToken(token: string): { address: string; iat: number; exp: number } | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", SECRET).update(body).digest("base64url");
  // Constant-time compare so the MAC cannot be recovered a byte at a time by timing.
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as { address: string; iat?: number; exp: number };
    if (p.exp <= Date.now()) return null;
    const iat = p.iat ?? 0;
    // Refuse tokens minted before the wallet's last "sign out everywhere".
    if (iat < signedOutBefore(p.address)) return null;
    return { address: p.address, iat, exp: p.exp };
  } catch {
    return null;
  }
}

function auth(req: Request, res: Response, next: NextFunction): void {
  const p = readToken((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  if (!p) { res.status(401).json({ error: "sign in first" }); return; }
  (req as Request & { owner: string }).owner = p.address;
  next();
}

/** Shape an unauthenticated route by client IP — there is no key to charge yet. */
function limitByIp(req: Request, res: Response, ratePerSec: number, burst: number): boolean {
  const r = take(`ip:${req.ip ?? "unknown"}`, ratePerSec, burst);
  res.setHeader("X-RateLimit-Remaining", String(r.remaining));
  if (!r.ok) {
    res.setHeader("Retry-After", String(r.retryAfter));
    res.status(429).json({ error: "too many requests", retryAfter: r.retryAfter });
    return false;
  }
  return true;
}

export function mountAccount(app: Express): void {
  // 1. Ask for a nonce to sign.
  app.get("/oracle/account/nonce", (req, res) => {
    if (!limitByIp(req, res, 1, 10)) return;
    sweepNonces();
    if (nonces.size >= MAX_NONCES) {
      res.status(503).json({ error: "sign-in temporarily unavailable — retry shortly" });
      return;
    }
    const nonce = randomBytes(16).toString("hex");
    nonces.set(nonce, Date.now() + NONCE_TTL_MS);
    res.json({ nonce, message: message(nonce) });
  });

  // 2. Verify the signature over the nonce → session token bound to the wallet.
  app.post("/oracle/account/verify", express.json({ limit: "8kb" }), async (req, res) => {
    if (!limitByIp(req, res, 1, 10)) return;
    const { address, signature, nonce } = (req.body ?? {}) as { address?: string; signature?: Hex; nonce?: string };
    const exp = nonce ? nonces.get(nonce) : undefined;
    if (!nonce || !exp || exp < Date.now()) { res.status(400).json({ error: "nonce missing or expired — request a fresh one" }); return; }
    nonces.delete(nonce); // one-time
    if (!address || !signature) { res.status(400).json({ error: "address and signature required" }); return; }
    let signer: string;
    try { signer = await recoverMessageAddress({ message: message(nonce), signature }); } catch { res.status(401).json({ error: "bad signature" }); return; }
    if (signer.toLowerCase() !== address.toLowerCase()) { res.status(401).json({ error: "signature does not match address" }); return; }
    const owner = signer.toLowerCase();
    // The free allowance is earned by last month's PAID usage — money that left this wallet
    // and reached the treasury. This is the Sybil gate, and unlike a score it cannot be
    // manufactured by transacting with yourself.
    const spend = paidCallsIn(owner, previousMonth());
    setOwnerTier(owner, tierOf(spend));
    const plan = ownerPlan(owner);
    res.json({
      token: signToken(owner),
      address: owner,
      tier: plan.tier,
      monthlyQuota: plan.monthlyQuota,
      qualifyingSpendLastMonth: spend,
    });
  });

  // 3. Owner-scoped key management.
  app.get("/oracle/account/keys", auth, (req, res) => {
    const owner = (req as Request & { owner: string }).owner;
    const plan = ownerPlan(owner);
    const used = usageOf(owner);
    res.json({
      keys: keysOf(owner),
      plan: { ...plan, ...PLANS[plan.tier], used, remaining: Math.max(0, plan.monthlyQuota - used) },
      maxKeys: MAX_KEYS_PER_OWNER,
    });
  });

  app.post("/oracle/account/keys", express.json({ limit: "8kb" }), auth, (req, res) => {
    const owner = (req as Request & { owner: string }).owner;
    // Minting is free and does not add quota, but an unbounded key table slows every
    // lookup that sums a wallet's usage — so the table is the thing being protected.
    if (countKeysOf(owner) >= MAX_KEYS_PER_OWNER) {
      res.status(409).json({ error: `at most ${MAX_KEYS_PER_OWNER} keys per wallet — revoke one first` });
      return;
    }
    const label = String((req.body as { label?: string })?.label ?? "key").slice(0, 40) || "key";
    res.json({ key: mintKeyFor(owner, label), label });
  });

  app.delete("/oracle/account/keys/:key", auth, (req, res) => {
    res.json({ revoked: revokeKey((req as Request & { owner: string }).owner, String(req.params.key)) });
  });

  // 4. Kill every session token for this wallet (a leaked 7-day token cannot otherwise be
  //    withdrawn without rotating the secret and signing everybody out).
  app.post("/oracle/account/signout-all", auth, (req, res) => {
    signOutAll((req as Request & { owner: string }).owner);
    res.json({ ok: true });
  });
}
