// Reputation scoring — a pure function over verified receipt records, so anyone can
// recompute every score from public on-chain data (the "not a black box" property).
//
// Model: Beta-style prior + decayed, capped evidence.
//   pos = Σ weight of good outcomes   (co-signed ×1, gateway-witnessed ×3)
//   neg = Σ weight of bad outcomes    (fail ×1/×3, dispute ×3 extra)
//   score = 100 · (pos + k·p0) / (pos + neg + k)
// with prior p0 = 0.25 and pseudo-count k = 5:
//   - a NEW agent starts at 25 (low-trust by default — sybils gain nothing by resetting)
//   - evidence decays with a 14-day half-life (old reputation fades; recent behaviour
//     dominates — no coasting on ancient wins, no permanent scars)
//   - each counterparty's contribution is capped at an ABSOLUTE 2.0 effective
//     receipts, so wash-trading with one friendly wallet (or a handful) cannot push a
//     score far — only many independent counterparties move it. (A relative cap — "20%
//     of total" — is self-referential and collapses when the wash wallet IS the total;
//     caught by the anti-wash unit test, hence the absolute form.)
export interface ReceiptRecord {
  provider: string;
  buyer: string;
  outcome: "success" | "fail" | "partial";
  disputed: boolean;
  witnessed: boolean; // gateway-attested (tier X)
  deliveredAt: number; // unix ms
  /**
   * Decimal USDC string from receipt.howMuch.usdc. Optional: omitted records weigh
   * as if they were reference-priced, so callers that don't track amounts are
   * unaffected.
   */
  usdc?: string;
  /**
   * Did the provider countersign? Only meaningful for the buyer-side score: a fail
   * receipt the provider never signed is a one-sided accusation. Defaults to true so
   * provider scoring is unaffected.
   */
  providerCountersigned?: boolean;
  /**
   * Which standard produced this evidence. Escrowed ERC-8183 jobs are harder to fake
   * than a co-signed receipt, and a job judged by a third party is harder still.
   * Defaults to "receipt".
   */
  tier?: EvidenceTier;
}

/**
 * Evidence tiers, ordered by how expensive the evidence is to manufacture.
 *   job-evaluated  ERC-8183, escrow funded up front, INDEPENDENT evaluator accepted
 *   job-self       ERC-8183, escrow funded, but the client evaluated its own job
 *   receipt        Oculopus co-signed receipt bound to a payment VISIBLE on chain
 *   receipt-x402   the same receipt, but settled through Circle Gateway off-chain
 * Raw ERC-8004 feedback is deliberately absent: it binds to nothing and is shown on
 * the dashboard for contrast, never scored.
 */
export type EvidenceTier = "job-evaluated" | "job-self" | "receipt" | "receipt-x402";

export interface ScoreBreakdown {
  score: number; // 0..100
  receipts: number;
  pos: number;
  neg: number;
  /** Distinct counterparties: buyers when scoring a provider, providers when scoring a buyer. */
  uniqueCounterparties: number;
}

export const SCORING = {
  prior: 0.25,
  pseudoCount: 5,
  halfLifeMs: 14 * 24 * 60 * 60 * 1000,
  witnessWeight: 3,
  disputeWeight: 3,
  counterpartyCapMass: 2.0, // max effective receipts any single counterparty contributes
  // Economic weight: a larger job is somewhat stronger evidence. Sub-linear (sqrt)
  // because a wash trader picks their own amounts for free — the money moves between
  // wallets they control on both sides.
  //
  // Range deliberately NARROW. A wider band (this was 0.5-4) makes an agent doing
  // $500 jobs gain standing 4x faster than one doing $0.002 jobs — a capital barrier
  // that penalises exactly the high-frequency micro-transaction pattern agent
  // commerce is made of. Value should break ties, not decide them; counterparty
  // diversity does the real work.
  valueReferenceUsdc: 0.002, // a receipt at this price weighs exactly 1
  valueWeightMin: 0.75,
  valueWeightMax: 1.5,
  // Evidence tier multipliers — see EvidenceTier.
  // x402 sits BELOW an on-chain receipt on purpose. Both carry two signatures, but on
  // the on-chain rail the payment itself is a public transfer anyone can check, while
  // Gateway settles off-chain and reports only an opaque settlement id. So a colluding
  // pair can mint x402 receipts without moving any money at all, where the on-chain
  // rail forces them to actually pay each other. The buyer's counter-signature is the
  // only thing standing behind an x402 payment claim — real evidence, but weaker.
  tierWeight: { "job-evaluated": 3, "job-self": 1.5, receipt: 1, "receipt-x402": 0.6 } as Record<EvidenceTier, number>,
  // Floor on propagated standing: a newcomer's word is worth little, never nothing.
  minStanding: 0.15,
} as const;

const decay = (ageMs: number) => Math.pow(0.5, Math.max(0, ageMs) / SCORING.halfLifeMs);

export function valueWeight(usdc?: string): number {
  if (usdc === undefined) return 1;
  const amount = Number(usdc);
  if (!Number.isFinite(amount) || amount <= 0) return SCORING.valueWeightMin;
  const w = Math.sqrt(amount / SCORING.valueReferenceUsdc);
  return Math.min(SCORING.valueWeightMax, Math.max(SCORING.valueWeightMin, w));
}

/**
 * Shared core: bucket weighted evidence by counterparty, cap the positive side, then
 * apply the Beta prior. Both directions of the market use the same arithmetic — only
 * what counts as good and bad evidence differs.
 */
function betaScore(
  records: ReceiptRecord[],
  counterpartyOf: (r: ReceiptRecord) => string,
  classify: (r: ReceiptRecord) => { pos: number; neg: number },
  now: number,
  standing?: Standing,
): ScoreBreakdown {
  // 1. raw decayed weight per record, bucketed by counterparty
  const perCounterparty = new Map<string, { pos: number; neg: number }>();
  for (const r of records) {
    const w =
      (r.witnessed ? SCORING.witnessWeight : 1) *
      SCORING.tierWeight[r.tier ?? "receipt"] *
      decay(now - r.deliveredAt) *
      valueWeight(r.usdc);
    const key = counterpartyOf(r).toLowerCase();
    // Trust propagation: evidence is worth what its author is worth. A cluster of
    // fresh wallets with no independent history of their own contributes almost
    // nothing, WITHOUT punishing two agents who legitimately trade both ways.
    const trust = standingOf(standing, key);
    const b = perCounterparty.get(key) ?? { pos: 0, neg: 0 };
    const c = classify(r);
    b.pos += c.pos * w * trust;
    // Negative evidence is NOT discounted by standing. Otherwise an attacker could
    // silence real complaints by making the complainant look unimportant, and a
    // brand-new buyer's genuine failure report would be worth nothing.
    b.neg += c.neg * w;
    perCounterparty.set(key, b);
  }

  // 2. absolute per-counterparty cap: each counterparty contributes at most capMass
  //    worth of POSITIVE evidence. Negative evidence is deliberately NOT capped — an
  //    attacker must not be able to launder away failures behind the cap, and honest
  //    failures should always count in full.
  let pos = 0;
  let neg = 0;
  for (const b of perCounterparty.values()) {
    const scale = b.pos > SCORING.counterpartyCapMass ? SCORING.counterpartyCapMass / b.pos : 1;
    pos += b.pos * scale;
    neg += b.neg;
  }

  // 3. Beta-prior score
  const score = (100 * (pos + SCORING.pseudoCount * SCORING.prior)) / (pos + neg + SCORING.pseudoCount);
  return {
    score: Math.round(score * 10) / 10,
    receipts: records.length,
    pos: Math.round(pos * 1000) / 1000,
    neg: Math.round(neg * 1000) / 1000,
    uniqueCounterparties: perCounterparty.size,
  };
}

/**
 * How much a counterparty's word is worth, 0..1, keyed by lowercase address.
 * Omitted counterparties count in full, so callers that don't compute standing get
 * exactly the previous behaviour.
 */
export type Standing = Map<string, number>;

const standingOf = (s: Standing | undefined, addr: string) => s?.get(addr.toLowerCase()) ?? 1;

export function scoreProvider(
  records: ReceiptRecord[],
  now = Date.now(),
  buyerStanding?: Standing,
): ScoreBreakdown {
  return betaScore(
    records,
    (r) => r.buyer,
    (r) => {
      if (r.disputed) return { pos: 0, neg: SCORING.disputeWeight };
      if (r.outcome === "success") return { pos: 1, neg: 0 };
      if (r.outcome === "fail") return { pos: 0, neg: 1 };
      return { pos: 0, neg: 0 }; // partial counts toward neither side
    },
    now,
    buyerStanding,
  );
}

/**
 * Standing in 0..1 derived from a score, for use as a propagation weight.
 *
 * A brand-new wallet sits at the 25 prior and lands at ~0.16 here, so a sybil
 * cluster that has never transacted independently barely moves anyone's score. It is
 * never zero: everyone has to be able to start somewhere.
 */
export function standingFromScore(score: number): number {
  return Math.max(SCORING.minStanding, Math.min(1, score / 100));
}

/**
 * One propagation pass over the whole receipt set.
 *
 * Round 1 scores every party with everyone counting equally. Round 2 rescores using
 * round 1 as the weight of each counterparty's word, and so on. Two passes is enough
 * in practice and keeps the result trivially recomputable — the auditability claim
 * dies if this becomes an opaque iterative model.
 */
export function propagate(records: ReceiptRecord[], now = Date.now(), rounds = 2): {
  providers: Map<string, ScoreBreakdown>;
  buyers: Map<string, ScoreBreakdown>;
} {
  const providerIds = [...new Set(records.map((r) => r.provider.toLowerCase()))];
  const buyerIds = [...new Set(records.map((r) => r.buyer.toLowerCase()))];
  let buyerStanding: Standing | undefined;
  let providers = new Map<string, ScoreBreakdown>();
  let buyers = new Map<string, ScoreBreakdown>();

  for (let i = 0; i < Math.max(1, rounds); i++) {
    providers = new Map(
      providerIds.map((p) => [p, scoreProvider(records.filter((r) => r.provider.toLowerCase() === p), now, buyerStanding)]),
    );
    buyers = new Map(
      buyerIds.map((b) => [b, scoreBuyer(records.filter((r) => r.buyer.toLowerCase() === b), now)]),
    );
    buyerStanding = new Map([...buyers].map(([addr, s]) => [addr, standingFromScore(s.score)]));
  }
  return { providers, buyers };
}

/**
 * The other side of the market: how safe is it to ACCEPT work from this buyer?
 *
 * Without this, publishing a receipt is charity — the buyer spends gas to build
 * someone else's reputation, which is a free-rider problem and the likeliest reason
 * a buyer would simply stop bothering. Scoring buyers too makes publishing
 * self-interested, and the data was already in every receipt.
 *
 * Good evidence: a completed job the provider also signed. The buyer paid, on chain,
 * and the provider agreed the description was accurate.
 *
 * Bad evidence: a failure the provider never countersigned. Those are legitimate —
 * a provider that vanishes will not sign its own failure — but they are also the
 * only receipt a buyer can write unilaterally, so a buyer whose history is unusually
 * full of them is the one providers should price for. Disputes count against too.
 */
export function scoreBuyer(records: ReceiptRecord[], now = Date.now()): ScoreBreakdown {
  return betaScore(
    records,
    (r) => r.provider,
    (r) => {
      if (r.disputed) return { pos: 0, neg: SCORING.disputeWeight };
      const mutual = r.providerCountersigned !== false;
      if (r.outcome === "success" && mutual) return { pos: 1, neg: 0 };
      if (r.outcome === "fail" && !mutual) return { pos: 0, neg: 1 };
      return { pos: 0, neg: 0 }; // countersigned failure: the provider agreed, no blame on the buyer
    },
    now,
  );
}
