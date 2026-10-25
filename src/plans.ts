// Plan tiers for the oracle's free allowance.
//
// The allowance is earned by PAID USAGE last month, not by score.
//
// Gating on the wallet's own Oculopus score was the obvious idea and it does not survive
// its own arithmetic: `npx tsx src/tierCalibration.ts` prices a self-dealt Platinum rating
// at roughly two cents of Arc gas, against a free grant worth dollars. Anything an attacker
// can mint for gas cannot guard something denominated in money.
//
// Paid usage has the property score does not: the money leaves the attacker and lands in
// the treasury. It cannot be manufactured by transacting with yourself, and it is measured
// in the same units as the thing being given away, so the giveaway ratio is explicit rather
// than implied. The tier is also a flow, not a stock — stop spending and it lapses next
// month, mirroring how the score's own 14-day half-life treats reputation.
export type Tier = "unverified" | "verified" | "trusted";

export interface Plan {
  readonly tier: Tier;
  /** Paid calls required LAST month to hold this tier THIS month. */
  readonly qualifyingSpend: number;
  /** Free reads per calendar month, shared across every key the wallet owns. */
  readonly monthlyQuota: number;
  /** Sustained requests per second. */
  readonly ratePerSec: number;
  /** Bucket depth — how big a burst is tolerated before throttling bites. */
  readonly burst: number;
}

// Ratios at the current $0.0001/call: Verified hands back 10x what it asks for, Trusted 5x.
// The taper is deliberate. What bounds the giveaway is not the ratio but the ABSOLUTE size
// of the grant — $1 and $5 are too small to be worth farming at any ratio, since an attacker
// must prepay real USDC per wallet and can only realise the value by actually consuming or
// reselling the calls. Raise these and the ratio starts to matter: keep grant value under
// about $5, or bring the multiplier down toward 2x.
export const PLANS: Readonly<Record<Tier, Plan>> = {
  unverified: { tier: "unverified", qualifyingSpend: 0, monthlyQuota: 1_000, ratePerSec: 1, burst: 5 },
  verified: { tier: "verified", qualifyingSpend: 1_000, monthlyQuota: 10_000, ratePerSec: 5, burst: 20 },
  trusted: { tier: "trusted", qualifyingSpend: 10_000, monthlyQuota: 50_000, ratePerSec: 10, burst: 40 },
};

/** Paid x402 callers are not on a free plan; this is the ceiling they are shaped to. */
export const PAID_RATE = { ratePerSec: 20, burst: 50 } as const;

/** Contracted plan — a cap plus fair use, not a metered subscription. */
export const PRO = {
  pricePerMonthUsd: 20,
  includedCalls: 500_000,
  ratePerSec: 50,
  burst: 100,
  /** Past the cap, usage simply bills at the pay-as-you-go rate. No new machinery. */
  overflow: "pay-as-you-go",
} as const;

/** Highest tier whose qualifying spend was met. Ordered high to low. */
const LADDER: readonly Plan[] = [PLANS.trusted, PLANS.verified, PLANS.unverified];

/**
 * Classify a wallet from how many PAID calls it made in the qualifying month.
 *
 * Deliberately a pure function of one number: it needs no upstream call, so sign-in cannot
 * be slowed or influenced by the node being busy, and the rule stays something a customer
 * can check against their own invoice.
 */
export function tierOf(paidCallsLastMonth: number): Tier {
  const spend = Number.isFinite(paidCallsLastMonth) ? Math.max(0, paidCallsLastMonth) : 0;
  return (LADDER.find((p) => spend >= p.qualifyingSpend) ?? PLANS.unverified).tier;
}
