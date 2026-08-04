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
import { ARC_TESTNET_CAIP2, GATEWAY_TESTNET_FACILITATOR } from "./x402.js";
import { consumeKey } from "./oracleKeys.js";
import { mountAccount } from "./oracleAccount.js";

const PORT = Number(process.env.ORACLE_PORT ?? 8791);
const UPSTREAM = process.env.ORACLE_UPSTREAM ?? `http://localhost:${process.env.NODE_PORT ?? 8790}`;
const SELLER = process.env.OCULOPUS_TREASURY_ADDRESS;
const PRICE = process.env.ORACLE_PRICE ?? "$0.0001"; // ~$1 per 10k calls — nanopayment scale, matches the free-tier monthly cap
if (!SELLER) throw new Error("Set OCULOPUS_TREASURY_ADDRESS in .env (run `npm run circle:wallet`).");

// The same tiers the docs and dashboard use — a distilled, standardised signal derived from
// the open score, so another protocol can price risk off one number without recomputing.
function creditTier(score: number): string {
  return score >= 55 ? "PLATINUM" : score >= 45 ? "GOLD" : score >= 35 ? "SILVER" : score >= 30 ? "BRONZE" : "UNRATED";
}

// Cache the upstream score per address for a short TTL so a burst of paid calls for the
// same agent doesn't hammer the node — reputation moves slowly, so a ~30s-old score is
// fine. An unknown address 404s upstream, itself a valid answer (UNRATED / 0), cached too.
const CACHE_MS = Number(process.env.ORACLE_CACHE_MS ?? 30_000);
const cache = new Map<string, { score: number; at: number }>();

async function scoreOf(addr: string): Promise<number> {
  const hit = cache.get(addr);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.score;
  const r = await fetch(`${UPSTREAM}/agents/${addr}`, { signal: AbortSignal.timeout(4000) });
  const score = r.ok ? Number(((await r.json()) as { score?: number }).score) || 0 : 0;
  if (cache.size > 5000) cache.clear(); // bound memory on a public endpoint
  cache.set(addr, { score, at: Date.now() });
  return score;
}

const app = express();
const gateway = createGatewayMiddleware({
  sellerAddress: SELLER,
  facilitatorUrl: GATEWAY_TESTNET_FACILITATOR,
  networks: [ARC_TESTNET_CAIP2],
});

// Free tier: a valid API key with monthly quota left bypasses x402 (grantAccess); keyless
// agents — or a key whose quota is spent — fall through to pay-per-call.
gateway.onProtectedRequest(async (ctx) => {
  const key = (ctx.getHeader("x-api-key") || (ctx.getHeader("authorization") || "").replace(/^Bearer\s+/i, "")) as string;
  if (consumeKey(key)) return { grantAccess: true };
});

// Dashboard: /oracle/account/* — wallet sign-in + owner-scoped API keys (free, not gated).
mountAccount(app);

// GET /oracle/:addr — paid. Returns a standardised credit tier for an agent address.
// Unpaid requests get a 402 with payment requirements; a paid request gets the payload.
app.get("/oracle/:addr", gateway.require(PRICE), async (req, res) => {
  const addr = String(req.params.addr).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return res.status(400).json({ error: "expected a 0x address" });
  try {
    const score = await scoreOf(addr);
    res.json({
      address: addr,
      score: +score.toFixed(1),
      creditTier: creditTier(score),
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
