// Proof Receipt — the privacy-preserving envelope around a receipt.
//
// A receipt (receipt.ts) splits into fields that are always safe to publish and fields
// an organisation may need to keep private: the counterparty, the amount, and *what was
// bought*. Publishing the whole receipt lets anyone walk tx -> memoId -> receipt and read
// exactly what an org paid for. That is fine for a marketplace agent that *wants* to be
// seen; it is a dealbreaker for a B2B/regulated one.
//
// A Proof Receipt fixes that with selective disclosure — the agent chooses per receipt:
//   - public:  the full SignedReceipt is published (today's behaviour). Max transparency.
//   - private: only { public fields, commitment, claims, proof } is published. The private
//              fields never leave the agent. memoId = commitment (not receiptHash), so
//              nobody can reverse tx -> receipt -> "what this org bought". A ZK proof
//              attests the properties that feed reputation, so the score is still trustable.
//
// Two independent privacy layers plug in here — do not conflate them:
//   1. This commitment + ZK layer (Oculopus, ships now): hides the receipt CONTENT
//      (service, prompt, response, taskRef, amount, counterparty) behind a commitment and
//      proves claims about it. Works on any rail today.
//   2. Arc opt-in privacy (APS precompile — ON ARC'S ROADMAP, not on testnet yet): encrypts
//      the on-chain PAYMENT itself so amount/parties are hidden at the ledger level. Arc's
//      privacy is enclave/TEE-based, *not* ZK, and disables event logs by default — so
//      until it lands we anchor the commitment through an ordinary public Memo tx.
//
// Scoring stays fully open and recomputable over the public fields + proven claims. Privacy
// is a property of the DATA, never of the formula.
import {
  keccak256,
  toHex,
  parseUnits,
  type Hex,
  type Address,
} from "viem";
import {
  canonicalize,
  receiptHash,
  type SignedReceipt,
  type Outcome,
} from "./receipt.js";
import type { ReceiptRecord, EvidenceTier } from "./scorer.js";

export type DisclosureMode = "public" | "private";
export type Rail = "onchain" | "x402" | "job";

// Always safe to publish + index. No amount, no counterparty, no free-text content.
export interface PublicFields {
  agentId: string | null; // ERC-8004 id of the provider, or null if unregistered
  provider: Address; // the agent this receipt credits
  serviceTag: number; // category tag only — not the free-text `service`
  requestedAt: number; // unix ms
  deliveredAt: number;
  outcome: Outcome; // needed for scoring; not itself sensitive
  rail: Rail;
}

// What an org may want hidden. Committed to; never published in private mode.
export interface PrivateFields {
  buyer: Address;
  usdc: string; // decimal string, e.g. "0.002"
  service: string; // free-text "what was bought"
  taskRef: string;
  requestHash: Hex;
  responseHash: Hex;
  latencyMs: number;
  salt: Hex; // 32-byte blinding factor so low-entropy fields can't be brute-forced
}

// The statement the proof attests about the (hidden) private fields. Public — this is
// exactly what a verifier learns instead of the raw data.
export interface ProvenClaims {
  bothSigned: boolean; // buyer + provider signatures both recovered valid
  amountTier: number; // proves usdc >= AMOUNT_TIERS[amountTier], without revealing usdc
  outcome: Outcome;
  disputed: boolean; // proven, so a private agent can't quietly hide its disputes
  // A per-counterparty pseudonym, stable across an agent's receipts with the same buyer.
  // Lets the indexer apply the per-counterparty cap in private mode WITHOUT learning who
  // the buyer is — the ZK circuit proves the nullifier was derived from the real buyer.
  counterpartyNullifier: Hex;
}

export interface ZkProof {
  // "commitment-only" is the honest fallback until the circuit lands: no zero-knowledge,
  // just the commitment. Never call this "ZK" in a demo — a reviewer will check.
  system: "groth16" | "plonk" | "noir" | "commitment-only";
  bytes: Hex;
}

export interface ProofReceipt {
  v: 1;
  mode: DisclosureMode;
  public: PublicFields;
  commitment: Hex; // commit(privateFields); the memoId in private mode
  claims: ProvenClaims;
  proof: ZkProof | null; // null until proven
  delta: number | null; // reputation contribution unlocked by a valid proof (scorer fills)
  signed?: SignedReceipt; // public mode only — full receipt, nothing hidden
}

// USDC floors (decimal strings). A range proof over these buckets is the minimal ZK claim:
// "the payment cleared and was worth at least tier N" — without revealing the exact amount.
export const AMOUNT_TIERS = ["0", "0.01", "0.10", "1.00", "10.00"] as const;

export function tierOf(usdc: string): number {
  const v = parseUnits(usdc, 6);
  let t = 0;
  for (let i = AMOUNT_TIERS.length - 1; i >= 1; i--) {
    if (v >= parseUnits(AMOUNT_TIERS[i]!, 6)) return i;
  }
  return t;
}

// Evidence tier for the scorer, from the public rail. x402 weighs less (off-chain
// settlement), an escrowed job more — the same table the open scoring uses.
export function railToTier(rail: Rail): EvidenceTier {
  return rail === "x402" ? "receipt-x402" : rail === "job" ? "job-evaluated" : "receipt";
}

// Counterparty pseudonym. Stable per (provider, buyer) pair so the per-counterparty cap
// still buckets a wash-trading pair together, opaque so the buyer stays private. Scaffold
// form (keccak over the pair); the production nullifier binds a secret witness inside the
// circuit so a known-address set cannot be brute-forced.
export function counterpartyNullifier(buyer: Address, provider: Address): Hex {
  return keccak256(toHex(canonicalize([buyer.toLowerCase(), provider.toLowerCase()])));
}

// ------------------------------------------------------------------- commitment --
// commit(private) = keccak256(canonical(privateFields)). The salt makes it *hiding*.
// A ZK circuit re-derives this same commitment from its private witness, so keccak is a
// fine scaffold; swap to Poseidon when the circuit lands (far cheaper inside a SNARK).
export function commit(priv: PrivateFields): Hex {
  return keccak256(toHex(canonicalize(priv)));
}

export function randomSalt(): Hex {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return toHex(b);
}

// A commitment binds: opening it (revealing the private fields) must reproduce it exactly.
export function opensTo(priv: PrivateFields, commitment: Hex): boolean {
  return commit(priv) === commitment;
}

// Split a signed receipt into its public and private halves.
export function split(
  signed: SignedReceipt,
  opts: { rail: Rail; agentId: string | null; serviceTag: number; salt?: Hex },
): { public: PublicFields; private: PrivateFields } {
  const r = signed.receipt;
  return {
    public: {
      agentId: opts.agentId,
      provider: r.who.provider,
      serviceTag: opts.serviceTag,
      requestedAt: r.when.requestedAt,
      deliveredAt: r.when.deliveredAt,
      outcome: r.effect.outcome,
      rail: opts.rail,
    },
    private: {
      buyer: r.who.buyer,
      usdc: r.howMuch.usdc,
      service: r.what.service,
      taskRef: r.why.taskRef,
      requestHash: r.how.requestHash,
      responseHash: r.how.responseHash,
      latencyMs: r.effect.latencyMs,
      salt: opts.salt ?? randomSalt(),
    },
  };
}

// Build a Proof Receipt. Public mode wraps today's SignedReceipt unchanged. Private mode
// publishes only commitment + claims; `proof` stays a `commitment-only` stub until the ZK
// circuit (roadmap step 2) replaces it. Either way the scorer derives `delta` from the
// proven claims, so a private agent earns a real, verifiable score with nothing exposed.
export function buildProofReceipt(args: {
  signed: SignedReceipt;
  mode: DisclosureMode;
  rail: Rail;
  agentId: string | null;
  serviceTag: number;
  bothSigned: boolean;
  salt?: Hex;
}): { proofReceipt: ProofReceipt; private: PrivateFields } {
  const parts = split(args.signed, { rail: args.rail, agentId: args.agentId, serviceTag: args.serviceTag, salt: args.salt });
  const commitment = commit(parts.private);
  const claims: ProvenClaims = {
    bothSigned: args.bothSigned,
    amountTier: tierOf(parts.private.usdc),
    outcome: parts.public.outcome,
    disputed: args.signed.receipt.risk.dispute,
    counterpartyNullifier: counterpartyNullifier(parts.private.buyer, parts.public.provider),
  };
  const proof: ZkProof = { system: "commitment-only", bytes: commitment };
  const proofReceipt: ProofReceipt =
    args.mode === "public"
      ? { v: 1, mode: "public", public: parts.public, commitment, claims, proof, delta: null, signed: args.signed }
      : { v: 1, mode: "private", public: parts.public, commitment, claims, proof, delta: null };
  return { proofReceipt, private: parts.private };
}

// The memoId a Proof Receipt anchors to: receiptHash in public mode (unchanged from
// today), the commitment in private mode. Same on-chain Memo machinery, different preimage
// — so verifyMemo.ts and the indexer keep working; a private receipt simply commits to a
// hash whose preimage the org never publishes.
export function proofMemoId(pr: ProofReceipt): Hex {
  return pr.mode === "public" && pr.signed ? receiptHash(pr.signed.receipt) : pr.commitment;
}

// The indexer side: turn a Proof Receipt into a record the open scorer consumes — the step
// that lets a PRIVATE receipt earn a real score without its data. Public mode passes the
// exact fields through unchanged; private mode feeds the scorer the tier-bucketed amount and
// the counterparty NULLIFIER in place of the buyer, so decay, the per-counterparty cap and
// pos/neg all still apply — computed over the claims, never the receipt.
export function toScoreRecord(pr: ProofReceipt): ReceiptRecord {
  const isPublic = pr.mode === "public" && !!pr.signed;
  const r = pr.signed?.receipt;
  return {
    provider: pr.public.provider,
    buyer: isPublic && r ? r.who.buyer : pr.claims.counterpartyNullifier,
    outcome: pr.public.outcome,
    disputed: pr.claims.disputed,
    witnessed: false,
    deliveredAt: pr.public.deliveredAt,
    usdc: isPublic && r ? r.howMuch.usdc : (AMOUNT_TIERS[pr.claims.amountTier] ?? "0"),
    providerCountersigned: pr.claims.bothSigned,
    tier: railToTier(pr.public.rail),
  };
}
