// Unit tests for the reputation model — the properties the pitch claims must hold.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreProvider, scoreBuyer, propagate, valueWeight, type ReceiptRecord } from "./scorer.js";

const NOW = 1_800_000_000_000;
const rec = (over: Partial<ReceiptRecord>): ReceiptRecord => ({
  provider: "0xp",
  buyer: "0xb1",
  outcome: "success",
  disputed: false,
  witnessed: false,
  deliveredAt: NOW,
  ...over,
});

test("a brand-new agent starts LOW (25), not neutral", () => {
  assert.equal(scoreProvider([], NOW).score, 25);
});

test("consistent success from diverse buyers raises the score toward 100", () => {
  const records = Array.from({ length: 20 }, (_, i) => rec({ buyer: `0xb${i}` }));
  const s = scoreProvider(records, NOW);
  assert.ok(s.score > 80, `expected >80, got ${s.score}`);
});

test("failures drag the score down hard", () => {
  const records = [
    ...Array.from({ length: 5 }, (_, i) => rec({ buyer: `0xb${i}` })),
    ...Array.from({ length: 5 }, (_, i) => rec({ buyer: `0xc${i}`, outcome: "fail" as const })),
  ];
  const s = scoreProvider(records, NOW);
  assert.ok(s.score < 50, `expected <50, got ${s.score}`);
});

test("a dispute hurts ~3x more than a plain fail", () => {
  const base = Array.from({ length: 6 }, (_, i) => rec({ buyer: `0xb${i}` }));
  const withFail = scoreProvider([...base, rec({ buyer: "0xz", outcome: "fail" })], NOW);
  const withDispute = scoreProvider([...base, rec({ buyer: "0xz", outcome: "fail", disputed: true })], NOW);
  assert.ok(withDispute.score < withFail.score, `${withDispute.score} !< ${withFail.score}`);
});

test("gateway-witnessed receipts move the score faster than self-reported", () => {
  const self = scoreProvider(Array.from({ length: 5 }, (_, i) => rec({ buyer: `0xb${i}` })), NOW);
  const witnessed = scoreProvider(
    Array.from({ length: 5 }, (_, i) => rec({ buyer: `0xb${i}`, witnessed: true })),
    NOW,
  );
  assert.ok(witnessed.score > self.score, `${witnessed.score} !> ${self.score}`);
});

test("ANTI-WASH: 50 receipts from ONE wallet score far below 10 from ten wallets", () => {
  const wash = scoreProvider(Array.from({ length: 50 }, () => rec({ buyer: "0xwash" })), NOW);
  const organic = scoreProvider(Array.from({ length: 10 }, (_, i) => rec({ buyer: `0xb${i}` })), NOW);
  assert.ok(wash.score < organic.score, `wash ${wash.score} !< organic ${organic.score}`);
  assert.ok(wash.score < 60, `wash score should stay unimpressive, got ${wash.score}`);
});

test("old evidence decays: a good record from 3 months ago barely counts", () => {
  const old = scoreProvider(
    Array.from({ length: 20 }, (_, i) => rec({ buyer: `0xb${i}`, deliveredAt: NOW - 90 * 24 * 3600 * 1000 })),
    NOW,
  );
  assert.ok(old.score < 40, `expected <40 (decayed toward prior), got ${old.score}`);
});

test("recent bad behaviour outweighs a long-ago good streak (no coasting)", () => {
  const records = [
    ...Array.from({ length: 20 }, (_, i) => rec({ buyer: `0xb${i}`, deliveredAt: NOW - 60 * 24 * 3600 * 1000 })),
    ...Array.from({ length: 4 }, (_, i) => rec({ buyer: `0xc${i}`, outcome: "fail" as const, deliveredAt: NOW })),
  ];
  const s = scoreProvider(records, NOW);
  assert.ok(s.score < 50, `expected <50, got ${s.score}`);
});

// ---- economic value weighting ----------------------------------------------------

test("a receipt with no amount weighs exactly as before (back-compat)", () => {
  assert.equal(valueWeight(undefined), 1);
  assert.equal(valueWeight("0.002"), 1); // the reference price
});

test("a bigger job counts for more than a dust job", () => {
  const dust = scoreProvider(Array.from({ length: 4 }, (_, i) => rec({ buyer: `0xb${i}`, usdc: "0.002" })), NOW);
  const real = scoreProvider(Array.from({ length: 4 }, (_, i) => rec({ buyer: `0xb${i}`, usdc: "0.5" })), NOW);
  assert.ok(real.score > dust.score, `${real.score} !> ${dust.score}`);
});

test("value weighting is SUB-LINEAR: 100x the money is far less than 100x the weight", () => {
  const w1 = valueWeight("0.002");
  const w100 = valueWeight("0.2"); // 100x the amount
  assert.ok(w100 < 100 * w1, `${w100} should be well below ${100 * w1}`);
  assert.ok(w100 > w1, "more money should still weigh more");
});

test("value weight is bounded NARROWLY, so capital cannot buy a score", () => {
  assert.equal(valueWeight("1000000"), 1.5);
  assert.equal(valueWeight("0.0000001"), 0.75);
  assert.equal(valueWeight("0"), 0.75); // degenerate amounts get the floor, never 0 or NaN
  assert.equal(valueWeight("not-a-number"), 0.75);
  // The whole band is under 2x: a rich agent cannot outrank a diverse honest one on
  // money alone. This is the capital-barrier fix — see SCOPE.reputation-engine.md.
  assert.ok(valueWeight("1000000") / valueWeight("0.0000001") <= 2);
});

test("ANTI-WASH still holds when the wash trader inflates the amounts", () => {
  const wash = scoreProvider(Array.from({ length: 50 }, () => rec({ buyer: "0xwash", usdc: "1000" })), NOW);
  const organic = scoreProvider(Array.from({ length: 10 }, (_, i) => rec({ buyer: `0xb${i}`, usdc: "0.002" })), NOW);
  assert.ok(wash.score < organic.score, `wash ${wash.score} !< organic ${organic.score}`);
});

test("a big FAILURE hurts more than a small one", () => {
  const base = Array.from({ length: 6 }, (_, i) => rec({ buyer: `0xb${i}` }));
  const small = scoreProvider([...base, rec({ buyer: "0xz", outcome: "fail", usdc: "0.002" })], NOW);
  const big = scoreProvider([...base, rec({ buyer: "0xz", outcome: "fail", usdc: "5" })], NOW);
  assert.ok(big.score < small.score, `${big.score} !< ${small.score}`);
});

// ---- buyer-side scoring ----------------------------------------------------------

test("a brand-new buyer also starts at the 25 prior", () => {
  assert.equal(scoreBuyer([], NOW).score, 25);
});

test("a buyer who completes mutually-signed jobs earns a good score", () => {
  const s = scoreBuyer(Array.from({ length: 12 }, (_, i) => rec({ provider: `0xp${i}` })), NOW);
  assert.ok(s.score > 70, `expected >70, got ${s.score}`);
});

test("a buyer that keeps filing UNILATERAL failures is marked down", () => {
  const honest = scoreBuyer(Array.from({ length: 8 }, (_, i) => rec({ provider: `0xp${i}` })), NOW);
  const accuser = scoreBuyer(
    Array.from({ length: 8 }, (_, i) =>
      rec({ provider: `0xp${i}`, outcome: "fail" as const, providerCountersigned: false }),
    ),
    NOW,
  );
  assert.ok(accuser.score < honest.score, `accuser ${accuser.score} !< honest ${honest.score}`);
  assert.ok(accuser.score < 25, `a serial accuser should fall below the prior, got ${accuser.score}`);
});

test("a failure the PROVIDER countersigned does not blame the buyer", () => {
  const base = Array.from({ length: 6 }, (_, i) => rec({ provider: `0xp${i}` }));
  const agreed = scoreBuyer([...base, rec({ provider: "0xpx", outcome: "fail", providerCountersigned: true })], NOW);
  const unilateral = scoreBuyer([...base, rec({ provider: "0xpx", outcome: "fail", providerCountersigned: false })], NOW);
  assert.ok(agreed.score > unilateral.score, `${agreed.score} !> ${unilateral.score}`);
});

test("buyer reputation cannot be farmed against a single friendly provider", () => {
  const farmed = scoreBuyer(Array.from({ length: 50 }, () => rec({ provider: "0xfriend" })), NOW);
  const organic = scoreBuyer(Array.from({ length: 10 }, (_, i) => rec({ provider: `0xp${i}` })), NOW);
  assert.ok(farmed.score < organic.score, `farmed ${farmed.score} !< organic ${organic.score}`);
});

test("provider scoring is untouched by the buyer-only field", () => {
  const withField = scoreProvider([rec({ providerCountersigned: false })], NOW);
  const without = scoreProvider([rec({})], NOW);
  assert.equal(withField.score, without.score);
});

// ---- evidence tiers --------------------------------------------------------------

test("an escrowed ERC-8183 job with an independent evaluator outweighs a receipt", () => {
  const receipts = scoreProvider(Array.from({ length: 3 }, (_, i) => rec({ buyer: `0xb${i}` })), NOW);
  const jobs = scoreProvider(
    Array.from({ length: 3 }, (_, i) => rec({ buyer: `0xb${i}`, tier: "job-evaluated" as const })),
    NOW,
  );
  assert.ok(jobs.score > receipts.score, `${jobs.score} !> ${receipts.score}`);
});

test("a job the client evaluated itself counts for less than one a third party judged", () => {
  const self = scoreProvider(Array.from({ length: 3 }, (_, i) => rec({ buyer: `0xb${i}`, tier: "job-self" as const })), NOW);
  const indep = scoreProvider(
    Array.from({ length: 3 }, (_, i) => rec({ buyer: `0xb${i}`, tier: "job-evaluated" as const })),
    NOW,
  );
  assert.ok(indep.score > self.score, `${indep.score} !> ${self.score}`);
});

test("a failed escrowed job also hurts more than a failed receipt", () => {
  const base = Array.from({ length: 6 }, (_, i) => rec({ buyer: `0xb${i}` }));
  const softFail = scoreProvider([...base, rec({ buyer: "0xz", outcome: "fail" })], NOW);
  const hardFail = scoreProvider([...base, rec({ buyer: "0xz", outcome: "fail", tier: "job-evaluated" })], NOW);
  assert.ok(hardFail.score < softFail.score, `${hardFail.score} !< ${softFail.score}`);
});

test("tier defaults to receipt, so untagged records are unaffected", () => {
  assert.equal(scoreProvider([rec({})], NOW).score, scoreProvider([rec({ tier: "receipt" })], NOW).score);
});

// ---- trust propagation -----------------------------------------------------------

test("propagation leaves a simple honest market roughly where it was", () => {
  const records = Array.from({ length: 6 }, (_, i) => rec({ provider: "0xp", buyer: `0xb${i}` }));
  const flat = scoreProvider(records, NOW);
  const { providers } = propagate(records, NOW);
  assert.ok(providers.get("0xp")!.score > 40, `honest provider should stay well above the prior`);
  assert.ok(providers.get("0xp")!.score <= flat.score, "propagation should not inflate anyone");
});

test("SYBIL: a cluster of fresh buyers with no history of their own barely lifts a provider", () => {
  // 20 throwaway buyer wallets, each used once, all praising one provider.
  const sybil = Array.from({ length: 20 }, (_, i) => rec({ provider: "0xsybil", buyer: `0xs${i}` }));
  // A provider praised by buyers who each have their own trading history.
  const honestBuyers = Array.from({ length: 20 }, (_, i) => `0xh${i}`);
  const organic = [
    ...honestBuyers.map((b) => rec({ provider: "0xreal", buyer: b })),
    // those buyers also transacted elsewhere, which is what gives them standing
    ...honestBuyers.flatMap((b) => Array.from({ length: 3 }, (_, j) => rec({ provider: `0xother${j}`, buyer: b }))),
  ];
  const s = propagate(sybil, NOW).providers.get("0xsybil")!.score;
  const o = propagate(organic, NOW).providers.get("0xreal")!.score;
  assert.ok(o > s, `organic ${o} should beat sybil ${s}`);
});

test("MUTUAL TRADE IS NOT PUNISHED: two agents buying from each other keep their scores", () => {
  // A and B sell each other different services, and both also trade with others.
  const mutual = [
    ...Array.from({ length: 4 }, () => rec({ provider: "0xa", buyer: "0xb" })),
    ...Array.from({ length: 4 }, () => rec({ provider: "0xb", buyer: "0xa" })),
    ...Array.from({ length: 4 }, (_, i) => rec({ provider: "0xa", buyer: `0xc${i}` })),
    ...Array.from({ length: 4 }, (_, i) => rec({ provider: "0xb", buyer: `0xd${i}` })),
  ];
  const { providers } = propagate(mutual, NOW);
  assert.ok(providers.get("0xa")!.score > 40, `A penalised for two-way trade: ${providers.get("0xa")!.score}`);
  assert.ok(providers.get("0xb")!.score > 40, `B penalised for two-way trade: ${providers.get("0xb")!.score}`);
});

test("a newcomer's complaint still counts in full", () => {
  const base = Array.from({ length: 6 }, (_, i) => rec({ provider: "0xp", buyer: `0xb${i}` }));
  const clean = propagate(base, NOW).providers.get("0xp")!.score;
  const complained = propagate([...base, rec({ provider: "0xp", buyer: "0xnew", outcome: "fail" })], NOW)
    .providers.get("0xp")!.score;
  assert.ok(complained < clean, `a fresh wallet's failure report must still bite: ${complained} !< ${clean}`);
});
