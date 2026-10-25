// Abuse tests — the adversarial half of the suite.
//
// The other test files check that the protocol computes the right answer for a well-behaved
// caller. These check what happens when the caller is not well-behaved: floods, quota
// overruns, table-stuffing, and reaching across ownership boundaries. Each test maps to a
// hole that was open before, so a regression here is a regression in the defence stack.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReceiptRecord } from "./scorer.js";

// The key store binds its DB path at import time, so point it at a throwaway file first.
const DIR = mkdtempSync(join(tmpdir(), "oculopus-abuse-"));
process.env.ORACLE_DB = join(DIR, "keys.db");
process.env.ORACLE_MAX_KEYS_PER_OWNER = "3";
process.env.ORACLE_MAX_BUCKETS = "50";

const keys = await import("./oracleKeys.js");
const { take, resetLimiter, bucketCount } = await import("./rateLimit.js");
const { tierOf, PLANS } = await import("./plans.js");
const { propagate, scoreProvider } = await import("./scorer.js");

process.on("exit", () => { try { rmSync(DIR, { recursive: true, force: true }); } catch { /* best effort */ } });

const WALLET_A = "0x1111111111111111111111111111111111111111";
const WALLET_B = "0x2222222222222222222222222222222222222222";

test("a spent monthly quota stops granting free reads", () => {
  keys.setOwnerTier(WALLET_A, "unverified"); // 100/month
  const k = keys.mintKeyFor(WALLET_A, "quota-test");
  const quota = PLANS.unverified.monthlyQuota;

  for (let i = 0; i < quota; i++) {
    assert.equal(keys.consumeKey(k).ok, true, `call ${i + 1} should be free`);
  }
  const over = keys.consumeKey(k);
  assert.equal(over.ok, false, "the call past the quota must fall through to x402");
  assert.equal(over.remaining, 0);
  assert.equal(keys.usageOf(WALLET_A), quota, "usage must stop at the quota, never exceed it");
});

test("minting more keys does not multiply the free allowance", () => {
  keys.setOwnerTier(WALLET_B, "unverified");
  const k1 = keys.mintKeyFor(WALLET_B, "one");
  const k2 = keys.mintKeyFor(WALLET_B, "two");
  const quota = PLANS.unverified.monthlyQuota;

  // Spend the whole allowance through the first key...
  for (let i = 0; i < quota; i++) keys.consumeKey(k1);
  // ...the second key must find nothing left: the quota belongs to the wallet.
  assert.equal(keys.consumeKey(k2).ok, false, "a second key must share the wallet's quota");
  assert.equal(keys.usageOf(WALLET_B), quota);
});

test("a wallet cannot stuff the key table without limit", () => {
  const owner = "0x3333333333333333333333333333333333333333";
  const max = keys.MAX_KEYS_PER_OWNER;
  for (let i = 0; i < max; i++) keys.mintKeyFor(owner, `k${i}`);
  assert.equal(keys.countKeysOf(owner), max);
  // The route refuses past this point; the store's job is to report the count truthfully
  // so the route can. Assert the boundary the route tests against.
  assert.ok(keys.countKeysOf(owner) >= max, "countKeysOf must reach the cap so the route can refuse");
});

test("one wallet cannot revoke another wallet's key", () => {
  const victimKey = keys.mintKeyFor(WALLET_A, "victim");
  const attacker = "0x4444444444444444444444444444444444444444";
  assert.equal(keys.revokeKey(attacker, victimKey), false, "cross-owner revoke must fail");
  assert.equal(keys.revokeKey(WALLET_A, victimKey), true, "the real owner can still revoke");
});

test("an unknown or empty key is never granted free access", () => {
  assert.equal(keys.consumeKey("oc_live_deadbeef").ok, false);
  assert.equal(keys.consumeKey("").ok, false);
  assert.equal(keys.consumeKey(null).ok, false);
  assert.equal(keys.consumeKey(undefined).ok, false);
});

test("signing out everywhere moves the token cut-off forward", () => {
  const before = keys.signedOutBefore(WALLET_A);
  keys.signOutAll(WALLET_A);
  assert.ok(keys.signedOutBefore(WALLET_A) > before, "the cut-off must advance so older tokens fail");
  assert.equal(keys.signedOutBefore("0x9999999999999999999999999999999999999999"), 0,
    "a wallet that never signed out has no cut-off");
});

test("the rate limiter throttles a burst and refuses with a retry hint", () => {
  resetLimiter();
  const burst = 5;
  for (let i = 0; i < burst; i++) {
    assert.equal(take("flood", 1, burst).ok, true, `burst call ${i + 1} should pass`);
  }
  const blocked = take("flood", 1, burst);
  assert.equal(blocked.ok, false, "the call past the burst must be throttled");
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.retryAfter >= 1, "a throttled caller must be told when to come back");
});

test("the rate limiter refills over time", async () => {
  resetLimiter();
  assert.equal(take("refill", 100, 1).ok, true);
  assert.equal(take("refill", 100, 1).ok, false, "bucket of 1 is empty after one call");
  await new Promise((r) => setTimeout(r, 60)); // 100/s → 60ms is ~6 tokens
  assert.equal(take("refill", 100, 1).ok, true, "the bucket must refill on its own");
});

test("the rate-limit table is bounded against caller-controlled keys", () => {
  resetLimiter();
  const max = Number(process.env.ORACLE_MAX_BUCKETS);
  // Every request from a fresh attacker IP would otherwise add a permanent entry — the
  // exact shape of the nonce-map leak this module was written to avoid repeating.
  for (let i = 0; i < max * 4; i++) take(`attacker-${i}`, 1, 1);
  assert.ok(bucketCount() <= max, `bucket table must stay bounded, saw ${bucketCount()} > ${max}`);
});

test("tier is earned by paid spend, and a wallet that never paid gets the floor", () => {
  assert.equal(tierOf(0), "unverified");
  assert.equal(tierOf(PLANS.verified.qualifyingSpend - 1), "unverified", "just under the bar is still the floor");
  assert.equal(tierOf(PLANS.verified.qualifyingSpend), "verified");
  assert.equal(tierOf(PLANS.trusted.qualifyingSpend), "trusted");
  assert.equal(tierOf(1e9), "trusted", "the ladder tops out, it does not wrap");
  // Garbage in must not promote anybody.
  assert.equal(tierOf(NaN), "unverified");
  assert.equal(tierOf(-5_000_000), "unverified");
});

test("a tier grant is never worth more than about five dollars", () => {
  // The giveaway is bounded by the ABSOLUTE grant, not the ratio — that is why this gate
  // stays safe at a 10x multiplier. If someone raises a quota without raising the
  // qualifying spend, this test is the thing that should stop them.
  const PRICE_USD = 0.0001;
  for (const plan of Object.values(PLANS)) {
    const grantValue = plan.monthlyQuota * PRICE_USD;
    assert.ok(grantValue <= 5, `${plan.tier} grant is worth $${grantValue.toFixed(2)} — too much to give away`);
  }
});

test("paid calls accrue per wallet per month and drive the tier", () => {
  const owner = "0x5555555555555555555555555555555555555555";
  assert.equal(keys.paidCallsIn(owner), 0, "a wallet starts with no spending history");
  for (let i = 0; i < PLANS.verified.qualifyingSpend; i++) keys.recordPaidCall(owner);
  assert.equal(keys.paidCallsIn(owner), PLANS.verified.qualifyingSpend);
  assert.equal(tierOf(keys.paidCallsIn(owner)), "verified");
  assert.equal(keys.paidCallsIn("0x6666666666666666666666666666666666666666"), 0, "spend is per wallet");
});

test("spending history survives key rotation", () => {
  // Spend is kept apart from api_keys on purpose: revoking a key must not erase the record
  // of money already paid, or a customer would lose their tier by tidying up.
  const owner = "0x7777777777777777777777777777777777777777";
  const k = keys.mintKeyFor(owner, "rotate-me");
  keys.recordPaidCall(owner);
  keys.recordPaidCall(owner);
  assert.equal(keys.revokeKey(owner, k), true);
  assert.equal(keys.paidCallsIn(owner), 2, "revoking a key must not wipe paid history");
});

test("the qualifying month is the previous one, not the current", () => {
  // Tier is earned by LAST month's spend, so a wallet cannot spend and instantly promote
  // itself mid-month, and a lapsed customer keeps its tier until the month turns.
  assert.equal(keys.previousMonth(new Date(Date.UTC(2026, 1, 15))), "2026-01");
  assert.equal(keys.previousMonth(new Date(Date.UTC(2026, 0, 3))), "2025-12", "the year must roll back too");
});

test("trust propagation cannot be escaped by sending more receipts", () => {
  // The bug: trust was applied per receipt and the cap applied afterwards, so a
  // low-standing wallet just emitted more receipts until the post-trust mass hit the cap
  // and the discount vanished — zero penalty from five receipts per wallet upward. The
  // cap must bound the RAW mass, with trust scaling that bound.
  const now = Date.now();
  const build = (partners: number, per: number): ReceiptRecord[] => {
    const out: ReceiptRecord[] = [];
    for (let c = 0; c < partners; c++) {
      for (let i = 0; i < per; i++) {
        out.push({
          provider: "0xp", buyer: `0xb${c}`, outcome: "success",
          disputed: false, witnessed: false, deliveredAt: now, usdc: "0.002",
        });
      }
    }
    return out;
  };

  const penaltyAt = (per: number): number => {
    const records = build(5, per);
    return propagate(records, now).providers.get("0xp")!.score - scoreProvider(records, now).score;
  };

  // Standing must still cost a self-dealing cluster real points...
  const baseline = penaltyAt(5);
  assert.ok(baseline < -5, `expected a real penalty at 5 receipts each, got ${baseline.toFixed(1)}`);
  // ...and piling on volume must not buy it back.
  for (const per of [10, 25, 50, 200]) {
    const p = penaltyAt(per);
    assert.ok(
      Math.abs(p - baseline) < 0.5,
      `penalty must not shrink with volume: ${baseline.toFixed(1)} at 5/wallet vs ${p.toFixed(1)} at ${per}/wallet`,
    );
  }
});

test("a single counterparty can never exceed the wash-trading ceiling", () => {
  // The absolute 2.0 cap is what actually stops wash trading, so pin the ceiling: one
  // friendly wallet, unlimited receipts, must stay well under the Silver band.
  const now = Date.now();
  const records: ReceiptRecord[] = Array.from({ length: 500 }, () => ({
    provider: "0xp", buyer: "0xfriend", outcome: "success" as const,
    disputed: false, witnessed: false, deliveredAt: now, usdc: "0.002",
  }));
  const s = scoreProvider(records, now).score;
  assert.ok(s < 50, `one counterparty must not reach Silver, got ${s.toFixed(1)}`);
  assert.ok(s > 40, `...but should still be meaningfully above the 25 floor, got ${s.toFixed(1)}`);
});

