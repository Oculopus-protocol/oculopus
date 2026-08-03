// Oculopus on Circle's x402 / Gateway rail.
//
// Why this file exists: Gateway Nanopayments produces NO on-chain transaction per paid
// call. The buyer signs an EIP-3009 authorization off-chain, the seller serves
// immediately, and Circle batches settlement later. So the Memo anchor this project is
// built on — "wrap the payment transaction" — has nothing to wrap on the rail Circle
// actually pushes for agent commerce.
//
// What it does have is a settlement hook that hands the seller the buyer's own signed
// authorization. That is enough:
//
//   buyer -> paid endpoint (x402)
//     Gateway middleware verifies + settles
//     onAfterSettle -> build a receipt carrying authHash + settlementId
//     provider signs it; the hash goes back in a response header
//     buyer verifies and counter-signs
//   every N receipts -> ONE Memo transaction anchoring a Merkle root
//
// Oculopus never touches a key and never relays a payment. It is a seller-side
// middleware plus a thin buyer-side client.
//
// Verified live on Arc Testnet (2026-07-20): deposit 1 USDC, one paid call to a
// protected endpoint, gateway balance 0.99 -> 0.98, receipt built at settle with the
// buyer's authorization hash. See docs/SCOPE (private) for the transcript.
import { keccak256, toHex, type Address, type Hex } from "viem";
import { canonicalize } from "./receipt.js";

/** Arc Testnet in CAIP-2, the form Circle's middleware expects. */
export const ARC_TESTNET_CAIP2 = "eip155:5042002";
export const GATEWAY_TESTNET_FACILITATOR = "https://gateway-api-testnet.circle.com";

/**
 * The subset of Circle's `SettleResultContext` that Oculopus reads.
 *
 * Declared structurally rather than imported so this module does not force
 * `@circle-fin/x402-batching` on anyone who only runs the on-chain path. A seller who
 * uses x402 passes the real context straight in.
 */
export interface SettleContextLike {
  paymentPayload: { payload?: Record<string, unknown> };
  requirements: { amount: string; network: string; asset?: string; payTo?: string };
  result: { payer?: string; transaction: string };
}

/**
 * A receipt for work paid through x402 rather than through a direct transfer.
 *
 * Same 5W2H1E1R spine as the on-chain receipt, with two fields the on-chain one has no
 * use for: the buyer's x402 authorization, and Circle's settlement id. `usdc` is a
 * decimal string, matching `Receipt.howMuch.usdc`, so both kinds score identically.
 */
export interface X402Receipt {
  v: 1;
  rail: "x402";
  who: { buyer: Address; provider: Address };
  what: { service: string; jobId: string };
  where: { endpoint: string; network: string };
  when: { requestedAt: number; deliveredAt: number };
  how: { requestHash: Hex; responseHash: Hex };
  howMuch: { usdc: string };
  effect: { outcome: "success" | "fail"; latencyMs: number };
  risk: { dispute: boolean };
  /** keccak of the buyer's signed x402 payment authorization. */
  authHash: Hex;
  /** Circle's settlement identifier for this payment. */
  settlementId: string;
}

/** Base-unit string (Circle reports "10000") to the decimal string receipts carry. */
export function toDecimalUsdc(baseUnits: string, decimals = 6): string {
  const negative = baseUnits.startsWith("-");
  const digits = (negative ? baseUnits.slice(1) : baseUnits).padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals);
  const frac = digits.slice(-decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

/** Same canonicalisation and hash as an on-chain receipt — one memoId format, one spec. */
export function x402ReceiptHash(receipt: X402Receipt): Hex {
  return keccak256(toHex(canonicalize(receipt)));
}

export interface BuildArgs {
  provider: Address;
  service: string;
  jobId: string;
  endpoint: string;
  requestedAt: number;
  requestHash: Hex;
  responseHash: Hex;
  outcome: "success" | "fail";
}

/**
 * Build a receipt from a settled x402 payment.
 *
 * The buyer's authorization is hashed rather than stored: it is their signed
 * commitment to this exact payment, so its hash is enough to prove the receipt refers
 * to a payment the buyer authorised, without republishing their signature.
 */
export function buildX402Receipt(ctx: SettleContextLike, args: BuildArgs): X402Receipt {
  const payer = ctx.result.payer;
  if (!payer) throw new Error("x402 settle context has no payer");
  return {
    v: 1,
    rail: "x402",
    who: { buyer: payer as Address, provider: args.provider },
    what: { service: args.service, jobId: args.jobId },
    where: { endpoint: args.endpoint, network: ctx.requirements.network },
    when: { requestedAt: args.requestedAt, deliveredAt: Date.now() },
    how: { requestHash: args.requestHash, responseHash: args.responseHash },
    howMuch: { usdc: toDecimalUsdc(ctx.requirements.amount) },
    effect: { outcome: args.outcome, latencyMs: Date.now() - args.requestedAt },
    risk: { dispute: false },
    authHash: keccak256(toHex(canonicalize(ctx.paymentPayload.payload ?? {}))),
    settlementId: ctx.result.transaction,
  };
}

// ------------------------------------------------------------------ merkle anchor ---
// One Memo transaction per batch instead of one per receipt. On this rail that is not
// an optimisation — there is no per-call transaction to attach to, so a root is the
// only thing to anchor. Costs measured on Arc: a Memo adds ~$0.0004, so a batch of 100
// anchors for about 4 millionths of a dollar per receipt.

// Leaves and internal nodes are hashed under DIFFERENT prefixes. Without this, an
// internal node verifies as if it were a leaf — an attacker takes hash(A,B) from a
// published tree and proves it is a receipt that was never in the batch. Confirmed
// against this exact code before the prefixes were added.
const LEAF_TAG = "00";
const NODE_TAG = "01";

/** Domain-separated leaf hash. Anchor and verify both go through this. */
export function merkleLeaf(receiptHash: Hex): Hex {
  return keccak256(`0x${LEAF_TAG}${receiptHash.slice(2)}`);
}

/** Sorted-pair hashing, so a proof needs no sibling-order flag. */
function hashPair(a: Hex, b: Hex): Hex {
  const [x, y] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(`0x${NODE_TAG}${x.slice(2)}${y.slice(2)}`);
}

/**
 * Merkle root over receipt hashes.
 *
 * An odd node is promoted rather than duplicated: duplicating a leaf lets the same
 * proof verify twice and is a known source of second-preimage bugs.
 */
export function merkleRoot(receiptHashes: Hex[]): Hex {
  if (!receiptHashes.length) throw new Error("merkleRoot: no leaves");
  let level = receiptHashes.map(merkleLeaf);
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? hashPair(level[i]!, level[i + 1]!) : level[i]!);
    }
    level = next;
  }
  return level[0]!;
}

/** Sibling path proving `index` is in the tree. */
export function merkleProof(receiptHashes: Hex[], index: number): Hex[] {
  if (index < 0 || index >= receiptHashes.length) throw new Error("merkleProof: index out of range");
  const proof: Hex[] = [];
  let level = receiptHashes.map(merkleLeaf);
  let idx = index;
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = i + 1 < level.length ? level[i + 1]! : undefined;
      if (right === undefined) {
        if (i === idx) idx = next.length; // promoted, no sibling to record
        next.push(left);
        continue;
      }
      if (i === idx) proof.push(right), (idx = next.length);
      else if (i + 1 === idx) proof.push(left), (idx = next.length);
      next.push(hashPair(left, right));
    }
    level = next;
  }
  return proof;
}

/** Anyone can run this against the root in the Memo — no Oculopus node required. */
export function verifyMerkleProof(receiptHash: Hex, proof: Hex[], root: Hex): boolean {
  return proof.reduce<Hex>((acc, sibling) => hashPair(acc, sibling), merkleLeaf(receiptHash)) === root;
}
