// The paid Reputation Oracle — Oculopus's agent-native, pay-per-call read on Arc.
//
// Free reads stay free on the node (the public good). THIS surface is the one an
// autonomous agent hits: it pays a fraction of a cent in USDC over x402 / Circle Gateway
// and gets a counterparty's standardised credit tier before it transacts. No human in the
// loop — the whole point of the Agentic Economy track.
//
//   npm run oracle        # starts on ORACLE_PORT (default 8791)
//
// Payment settles to the Oculopus treasury (a Circle developer-controlled wallet on Arc);
// the reputation itself is read from the node's free API, so the oracle stays a thin,
// stateless paywall over the open score.
import "dotenv/config";
import express from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { gatewayConfig } from "./x402.js";
import { NETWORK } from "./config.js";
import { consumeKey, ownerOfKey, recordPaidCall } from "./oracleKeys.js";
import { mountAccount } from "./oracleAccount.js";
import { PAID_RATE, PLANS } from "./plans.js";
import { take } from "./rateLimit.js";

const PORT = Number(process.env.ORACLE_PORT ?? 8791);
const UPSTREAM = process.env.ORACLE_UPSTREAM ?? `http://localhost:${process.env.NODE_PORT ?? 8790}`;
const SELLER = process.env.OCULOPUS_TREASURY_ADDRESS;
const PRICE = process.env.ORACLE_PRICE ?? "$0.0001"; // ~$1 per 10k calls — nanopayment scale, matches the free-tier monthly cap
if (!SELLER) throw new Error("Set OCULOPUS_TREASURY_ADDRESS in .env (run `npm run circle:wallet`).");

// The same tiers the docs and dashboard use — a distilled, standardised signal derived from
// the open score, so another protocol can price risk off one number without recomputing.
//
// Every threshold is a COUNTERPARTY COUNT, not a round number. Because a single counterparty
// contributes at most an absolute 2.0 of positive mass, the reachable ceiling is fixed by how
// many independent parties vouched for an agent:
//
//     1 partner  ceiling 46.4      3 partners ceiling 65.9      10 partners ceiling 85.0
//     2 partners ceiling 58.3      5 partners ceiling 75.0
//
// So a tier answers a question a lender actually has — "how many independent counterparties
// stand behind this?" — rather than describing an arbitrary slice of a curve. Recompute the
// table any time the scoring constants move: `npx tsx src/tierCalibration.ts`.
//
// The previous thresholds (30/35/45/55) predated the counterparty cap and were badly wrong:
// 46.4 — the ceiling a wash-trader reaches with ONE friendly wallet — graded as GOLD.
const TIERS = [
  { min: 75, name: "PLATINUM" }, // >= 5 independent counterparties
  { min: 59, name: "GOLD" }, //     3-4
  { min: 47, name: "SILVER" }, //   2
  { min: 0, name: "BRONZE" }, //    1, or a wallet still at the 25 prior
] as const;

/**
 * An agent with no verified receipt at all is UNRATED, never BRONZE. A fresh wallet sits at
 * the 25 prior, and grading the absence of evidence as a credit band would certify something
 * we know nothing about — the one thing a credit signal must never do.
 */
function creditTier(score: number, receipts: number): string {
  if (receipts < 1) return "UNRATED";
  return TIERS.find((t) => score >= t.min)?.name ?? "BRONZE";
}

// Cache the upstream score per address for a short TTL so a burst of paid calls for the
// same agent doesn't hammer the node — reputation moves slowly, so a ~30s-old score is
// fine. An unknown address 404s upstream, itself a valid answer (UNRATED / 0), cached too.
const CACHE_MS = Number(process.env.ORACLE_CACHE_MS ?? 30_000);
interface Reading { score: number; receipts: number }
const cache = new Map<string, Reading & { at: number }>();

async function scoreOf(addr: string): Promise<Reading> {
  const hit = cache.get(addr);
  if (hit && Date.now() - hit.at < CACHE_MS) return { score: hit.score, receipts: hit.receipts };
  const r = await fetch(`${UPSTREAM}/agents/${addr}`, { signal: AbortSignal.timeout(4000) });
  const body = r.ok ? ((await r.json()) as { score?: number; receipts?: number }) : {};
  // An address the node has never seen reads as zero evidence, which is itself the answer
  // (UNRATED) rather than an error — and is cached like any other.
  const reading: Reading = { score: Number(body.score) || 0, receipts: Number(body.receipts) || 0 };
  if (cache.size > 5000) cache.clear(); // bound memory on a public endpoint
  cache.set(addr, { ...reading, at: Date.now() });
  return reading;
}

const app = express();
app.disable("x-powered-by"); // don't advertise the stack on a public surface
app.set("trust proxy", 1); // one nginx hop in front — so req.ip is the real client

// CORS — the dashboard on oculopus.xyz calls these endpoints cross-origin. Auth is a Bearer
// token (not cookies), so a wildcard origin is safe; preflight (OPTIONS) short-circuits here.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, x-api-key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if (req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});

/** Read the caller's API key from either accepted header. */
function apiKeyOf(req: express.Request): string {
  return (req.get("x-api-key") || (req.get("authorization") || "").replace(/^Bearer\s+/i, "")).trim();
}
const gw = gatewayConfig(NETWORK);
const gateway = createGatewayMiddleware({
  sellerAddress: SELLER,
  facilitatorUrl: gw.facilitatorUrl,
  networks: [gw.caip2],
});

const payWall = gateway.require(PRICE);

/**
 * Free tier, then the paywall.
 *
 * A valid API key with monthly quota left is served free and skips x402 entirely; keyless
 * agents — or a key whose quota is spent — fall through to pay-per-call.
 *
 * This replaces the gateway's own onProtectedRequest hook rather than sitting beside it:
 * with both in place a keyed request would be charged against its quota twice. Doing the
 * decision here also puts the settled-payment callback in reach, which is what lets a paid
 * call count toward next month's tier.
 */
function freeOrPay(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const key = apiKeyOf(req);
  const r = consumeKey(key);
  if (r.ok) {
    res.setHeader("X-Quota-Limit", String(r.quota));
    res.setHeader("X-Quota-Remaining", String(r.remaining));
    if (r.tier) res.setHeader("X-Oculopus-Plan", r.tier);
    next();
    return;
  }
  if (key) res.setHeader("X-Quota-Remaining", "0");
  payWall(req, res, (err?: unknown) => {
    if (err) { next(err as Error); return; }
    // Past the paywall means the payment settled. Only a keyed caller accrues spend —
    // there is no wallet to credit otherwise, which is also the reason to keep sending
    // your key on paid calls.
    const owner = key ? ownerOfKey(key) : null;
    if (owner) recordPaidCall(owner);
    next();
  });
}

// Layer 3: shape each caller before any of the above runs. A monthly quota alone does not
// stop a caller draining a month of allowance in under a minute, and the paid path needs a
// ceiling too so one agent cannot saturate the node for everyone else.
function shape(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const key = apiKeyOf(req);
  // A keyed caller is charged against its key so it keeps its allowance behind a NAT;
  // a keyless one (paying per call, or about to get a 402) is shaped by IP.
  const bucket = key ? `key:${key}` : `ip:${req.ip ?? "unknown"}`;
  const { ratePerSec, burst } = key ? PLANS.verified : PAID_RATE;
  const r = take(bucket, ratePerSec, burst);
  res.setHeader("X-RateLimit-Limit", String(ratePerSec));
  res.setHeader("X-RateLimit-Remaining", String(r.remaining));
  if (!r.ok) {
    res.setHeader("Retry-After", String(r.retryAfter));
    res.status(429).json({ error: "too many requests", retryAfter: r.retryAfter });
    return;
  }
  next();
}

// Dashboard: /oracle/account/* — wallet sign-in + owner-scoped API keys (free, not gated).
mountAccount(app);

// GET /oracle/:addr — paid. Returns a standardised credit tier for an agent address.
// Unpaid requests get a 402 with payment requirements; a paid request gets the payload.
app.get("/oracle/:addr", shape, freeOrPay, async (req, res) => {
  const addr = String(req.params.addr).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return res.status(400).json({ error: "expected a 0x address" });
  res.setHeader("Cache-Control", `public, max-age=${Math.floor(CACHE_MS / 1000)}`);
  try {
    const { score, receipts } = await scoreOf(addr);
    res.json({
      address: addr,
      score: +score.toFixed(1),
      creditTier: creditTier(score, receipts),
      receipts,
      asOf: new Date().toISOString(),
      source: "oculopus",
    });
  } catch {
    res.status(502).json({ error: "reputation upstream unavailable" });
  }
});

app.listen(PORT, () =>
  console.log(`Oculopus paid oracle → http://localhost:${PORT}/oracle/:addr  (price ${PRICE} → ${SELLER} on Arc testnet)`),
);
