// Publish an Oculopus receipt as ERC-8004 feedback.
//
// This is the join between the two systems. ERC-8004's ReputationRegistry accepts
// feedback from anyone with a wallet and binds it to nothing — the rated agent never
// signs, and no payment need exist. Oculopus feedback carries the missing link:
//
//   feedbackHash = memoId = keccak256(co-signed receipt)
//
// That same memoId is an INDEXED topic on the Memo event of the USDC payment. So any
// reader — not just an Oculopus node — can take a feedback entry, eth_getLogs the
// memoId, and confirm a real payment carried this exact receipt, then fetch the
// receipt at feedbackURI and check both parties' EIP-712 signatures over it.
//
// Feedback is published BY THE BUYER, not by the node. If the node published on
// everyone's behalf, every entry would share one client address and our own
// per-counterparty cap would (correctly) collapse the score to noise.
import { createPublicClient, createWalletClient, encodeFunctionData, fallback, http, type Account, type Address, type Hex } from "viem";
import { arcTestnet, CONTRACTS, RPC_URLS } from "./config.js";
import { ERC8004, reputationAbi, identityAbi } from "./erc8004.js";
import { multicall3FromAbi } from "./abi.js";

/** 0..100 at valueDecimals 0 — the same scale agentId 1 uses on Arc testnet today. */
const RATING_DECIMALS = 0;
const RATING_SUCCESS = 100n;
const RATING_FAIL = 0n;

export interface FeedbackInput {
  /** The provider's ERC-8004 agentId. */
  agentId: bigint;
  outcome: "success" | "fail" | "partial";
  /** Service label, published as tag1 so readers can filter by service. */
  service: string;
  /** Where the job was served. */
  endpoint: string;
  /** Resolvable URL of the co-signed receipt document. */
  feedbackURI: string;
  /** memoId == receiptHash — the link to the on-chain payment. */
  receiptHash: Hex;
}

/**
 * Does `agentId` actually belong to `provider`?
 *
 * `giveFeedback(agentId, …, feedbackHash)` does NOT check that the hash has
 * anything to do with the agent — feedbackHash is opaque bytes32. So a valid,
 * paid, co-signed receipt whose provider is Y can be published as feedback about
 * agent X, and a reader that only checks "is the receipt real?" would credit X
 * with Y's work. Everything verifies; the attribution is simply a lie.
 *
 * The missing link is this call. Publishers use it so they never emit a
 * mis-attributed entry; readers must run it before trusting one.
 */
export async function agentOwnsAddress(agentId: bigint, provider: Address): Promise<boolean> {
  const pub = createPublicClient({
    chain: arcTestnet,
    transport: fallback(RPC_URLS.map((u) => http(u, { retryCount: 4, retryDelay: 1500 }))),
  });
  const wallet = await pub.readContract({
    address: ERC8004.identity,
    abi: identityAbi,
    functionName: "getAgentWallet",
    args: [agentId],
  });
  return wallet.toLowerCase() === provider.toLowerCase();
}

/**
 * Below this job value, publishing to ERC-8004 per job costs more than the job.
 *
 * Measured on Arc testnet at 20.9 gwei: the payment itself is $0.00103 and happens
 * regardless; anchoring the receipt in a Memo adds **$0.0004**; `giveFeedback` adds
 * **$0.00274** — 87% of Oculopus's marginal cost. Most of that is ERC-8004's own
 * storage layout, not our payload: stripping every string still costs $0.00187.
 *
 * And it buys nothing for the score. The node computes standing from verified receipts
 * and settled ERC-8183 jobs; ERC-8004 feedback is read only to display the unverified
 * figure beside ours. What publishing buys is INTEROP — being visible to readers that
 * speak ERC-8004 and nothing else. That is worth paying for periodically, not per job.
 */
export const FEEDBACK_MIN_USDC = 0.1;

/** Just the calldata, so a caller can batch many of these into one transaction. */
export function encodeFeedback(input: FeedbackInput): Hex {
  return encodeFunctionData({
    abi: reputationAbi,
    functionName: "giveFeedback",
    args: [
      input.agentId,
      input.outcome === "success" ? RATING_SUCCESS : RATING_FAIL,
      RATING_DECIMALS,
      input.service,
      input.outcome,
      input.endpoint,
      input.feedbackURI,
      input.receiptHash,
    ],
  });
}

/**
 * Publish several receipts as ERC-8004 feedback in ONE transaction.
 *
 * This is the intended path for anything below FEEDBACK_MIN_USDC: keep anchoring every
 * receipt on-chain (cheap, and it is what the score actually reads), then broadcast to
 * the registry in batches so the fixed per-entry cost is amortised instead of being
 * charged to every micro-job.
 */
export async function publishFeedbackBatch(account: Account, inputs: FeedbackInput[]): Promise<Hex> {
  if (!inputs.length) throw new Error("publishFeedbackBatch: nothing to publish");
  const wallet = createWalletClient({
    account,
    chain: arcTestnet,
    transport: fallback(RPC_URLS.map((u) => http(u, { retryCount: 4, retryDelay: 1500 }))),
  });
  return wallet.writeContract({
    address: CONTRACTS.multicall3From,
    abi: multicall3FromAbi,
    functionName: "aggregate3",
    args: [
      inputs.map((i) => ({
        target: ERC8004.reputation as `0x${string}`,
        allowFailure: false,
        callData: encodeFeedback(i),
      })),
    ],
  });
}

export async function publishFeedback(account: Account, input: FeedbackInput): Promise<Hex> {
  const wallet = createWalletClient({
    account,
    chain: arcTestnet,
    transport: fallback(RPC_URLS.map((u) => http(u, { retryCount: 4, retryDelay: 1500 }))),
  });
  return wallet.sendTransaction({ to: ERC8004.reputation, data: encodeFeedback(input) });
}
