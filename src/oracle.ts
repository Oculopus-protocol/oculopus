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

const app = express();
const gateway = createGatewayMiddleware({
  sellerAddress: SELLER,
  facilitatorUrl: GATEWAY_TESTNET_FACILITATOR,
  networks: [ARC_TESTNET_CAIP2],
});

// GET /oracle/:addr — paid. Returns a standardised credit tier for an agent address.
// Unpaid requests get a 402 with payment requirements; a paid request gets the payload.
app.get("/oracle/:addr", gateway.require(PRICE), async (req, res) => {
  const addr = String(req.params.addr).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return res.status(400).json({ error: "expected a 0x address" });
  try {
    // A registered agent with receipts returns a score; an unknown address 404s upstream,
    // which is itself a valid credit answer — "no track record" → UNRATED — not an error.
    // The caller already paid, so always hand back a usable tier rather than a 404.
    const r = await fetch(`${UPSTREAM}/agents/${addr}`, { signal: AbortSignal.timeout(4000) });
    const score = r.ok ? Number(((await r.json()) as { score?: number }).score) || 0 : 0;
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
