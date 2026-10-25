// Tier calibration — what does a score actually COST to reach?
//
// Run: npx tsx src/tierCalibration.ts
//
// Uses the real scorer, not a model of it, so the numbers below are the numbers the
// protocol produces. The question being answered: if the free tier is gated on score,
// how much USDC does an attacker spend to farm each band, and can an honest agent
// reach it at all?
import { propagate, scoreProvider, SCORING, type ReceiptRecord } from "./scorer.js";

const NOW = Date.now();
const REF = Number(SCORING.valueReferenceUsdc); // 0.002 — a receipt at this price weighs 1
const GAS_PER_MEMO = 0.001; // USDC, from the gas sheet (~21.1 gwei on Arc)

const f1 = (n: number): string => n.toFixed(1);
const f2 = (n: number): string => n.toFixed(2);

/** Build `count` success receipts from each of `counterparties` distinct buyers. */
function receipts(counterparties: number, perCounterparty: number, ageDays = 0, usdc = String(REF)): ReceiptRecord[] {
  const out: ReceiptRecord[] = [];
  for (let c = 0; c < counterparties; c++) {
    for (let i = 0; i < perCounterparty; i++) {
      out.push({
        provider: "0xprovider",
        buyer: `0xbuyer${c}`,
        outcome: "success",
        disputed: false,
        witnessed: false,
        deliveredAt: NOW - ageDays * 86_400_000,
        usdc,
      });
    }
  }
  return out;
}

console.log("═".repeat(78));
console.log("1. HARD CEILING PER COUNTERPARTY COUNT");
console.log("   Cap is an ABSOLUTE 2.0 positive mass per counterparty, so the number of");
console.log("   DISTINCT partners — not the number of receipts — sets the ceiling.");
console.log("═".repeat(78));
console.log("  partners |  ceiling score  | reachable band");
for (const n of [1, 2, 3, 4, 5, 7, 10, 20]) {
  // 200 receipts each: far past the cap, so this is the asymptote.
  const s = scoreProvider(receipts(n, 200), NOW).score;
  const band = s >= 75 ? "PLATINUM" : s >= 50 ? "SILVER" : "BRONZE";
  console.log(`  ${String(n).padStart(8)} | ${f1(s).padStart(14)}  | ${band}`);
}

console.log();
console.log("═".repeat(78));
console.log("2. CHEAPEST PATH TO EACH BAND (all-success, fresh, reference-priced)");
console.log("   Minimum receipts to cross the line, and what that costs on-chain.");
console.log("═".repeat(78));
console.log("  target | partners | receipts | USDC moved | gas    | TOTAL COST");
for (const target of [50, 60, 75, 85]) {
  let best: { partners: number; total: number; usdc: number; gas: number } | null = null;
  for (let partners = 1; partners <= 40; partners++) {
    for (let per = 1; per <= 40; per++) {
      if (scoreProvider(receipts(partners, per), NOW).score < target) continue;
      const total = partners * per;
      // Self-dealing: the USDC returns to the attacker, only gas is burned. Counted
      // separately so both readings are visible.
      const usdc = total * REF;
      const gas = total * GAS_PER_MEMO;
      if (!best || total < best.total) best = { partners, total, usdc, gas };
      break;
    }
  }
  if (best) {
    console.log(
      `  ${String(target).padStart(6)} | ${String(best.partners).padStart(8)} | ${String(best.total).padStart(8)} | ` +
        `$${f2(best.usdc).padStart(9)} | $${f2(best.gas).padStart(5)} | $${f2(best.usdc + best.gas)}`,
    );
  } else {
    console.log(`  ${String(target).padStart(6)} | UNREACHABLE within 40 partners x 40 receipts`);
  }
}

console.log();
console.log("═".repeat(78));
console.log("3. SELF-DEALING WITH TRUST PROPAGATION (the real attacker case)");
console.log("   The attacker owns every wallet, so every counterparty is itself a fresh");
console.log("   wallet. propagate() runs 2 rounds and discounts their word accordingly.");
console.log("═".repeat(78));
console.log("  partners | receipts each | provider score (propagated) | band");
for (const n of [1, 2, 3, 5, 10, 20]) {
  for (const per of [5, 20]) {
    const { providers } = propagate(receipts(n, per), NOW);
    const s = providers.get("0xprovider")!.score;
    const band = s >= 75 ? "PLATINUM" : s >= 50 ? "SILVER" : "BRONZE";
    console.log(`  ${String(n).padStart(8)} | ${String(per).padStart(13)} | ${f1(s).padStart(27)} | ${band}`);
  }
}

console.log();
console.log("═".repeat(78));
console.log("4. DECAY — WHAT IT COSTS TO *KEEP* A BAND");
console.log("   Half-life 14d. A score is a flow, not a stock: stop trading and it falls.");
console.log("═".repeat(78));
const held = receipts(5, 4); // a mid-sized honest history
console.log("  days idle | score");
for (const d of [0, 7, 14, 30, 60, 90]) {
  const aged = receipts(5, 4, d);
  console.log(`  ${String(d).padStart(9)} | ${f1(scoreProvider(aged, NOW).score)}`);
}
void held;

console.log();
console.log("═".repeat(78));
console.log("5. WHY THE LIVE DEMO SHOWS ~29 FOR EVERYONE");
console.log("   api.oculopus.xyz/directory tops out at 29.7 with 12 receipts and 4");
console.log("   partners. Reproduce that to find the age of the seeded data.");
console.log("═".repeat(78));
for (const age of [0, 14, 30, 44, 60]) {
  const { providers } = propagate(receipts(4, 3, age), NOW);
  console.log(`  seeded ${String(age).padStart(2)}d ago -> provider score ${f1(providers.get("0xprovider")!.score)}`);
}

console.log();
console.log("═".repeat(78));
console.log("6. PROPOSED BANDS vs CURRENT ORACLE THRESHOLDS");
console.log("═".repeat(78));
const current = (s: number): string =>
  s >= 55 ? "PLATINUM" : s >= 45 ? "GOLD" : s >= 35 ? "SILVER" : s >= 30 ? "BRONZE" : "UNRATED";
const proposed = (s: number): string => (s >= 75 ? "PLATINUM" : s >= 50 ? "SILVER" : "BRONZE");
console.log("  score | current oracle | proposed | note");
for (const s of [25, 29.7, 35, 46.4, 50, 58.3, 65.9, 75, 85]) {
  let note = "";
  if (s === 25) note = "brand-new wallet, zero evidence";
  if (s === 29.7) note = "TOP agent on the live site today";
  if (s === 46.4) note = "ceiling for ONE counterparty — wash-trading cap";
  if (s === 58.3) note = "ceiling for two";
  if (s === 65.9) note = "ceiling for three";
  if (s === 75) note = "needs five distinct partners";
  console.log(`  ${f1(s).padStart(5)} | ${current(s).padEnd(14)} | ${proposed(s).padEnd(8)} | ${note}`);
}
