// The buyer agent — the autonomy in the demo. Every round it:
//   1. queries the Oculopus directory and picks the HIGHEST-SCORED provider
//   2. buys the job over plain HTTP
//   3. builds the 5W2H1E1R receipt, signs it, gets the provider's countersignature
//   4. publishes the receipt, then pays on Arc via Memo.memo — the memo carries the
//      receipt hash, anchoring the record to the payment
// A provider that starts failing earns fail receipts → its score drops → step 1
// routes the next round somewhere else. No human in the loop.
import {
  createPublicClient,
  createWalletClient,
  http,
  fallback,
  encodeFunctionData,
  keccak256,
  toHex,
  parseUnits,
  type Account,
  type Hex,
} from "viem";
import { arcTestnet, CONTRACTS, RPC_URLS } from "../config.js";
import { memoAbi, erc20Abi, multicall3FromAbi } from "../abi.js";
import {
  canonicalize,
  receiptHash,
  signReceipt,
  encodeMemoData,
  MEMO_KIND,
  type Receipt,
  type SignedReceipt,
} from "../receipt.js";
import { agentOwnsAddress, encodeFeedback, FEEDBACK_MIN_USDC, type FeedbackInput } from "../feedback.js";
import { ERC8004 } from "../erc8004.js";
import { categorySlug } from "../categories.js";

export interface BuyerOptions {
  account: Account;
  nodeUrl: string; // Oculopus node
  serviceTag: number;
  taskRef: string;
  /** provider address (lowercase) -> ERC-8004 agentId. Omit to skip publishing feedback. */
  agentIds?: Record<string, string>;
  /** Return the settlement calls instead of sending them, for batching via settleBatch. */
  deferSettlement?: boolean;
  /**
   * When to mirror the receipt into ERC-8004. "auto" (default) publishes inline only
   * for jobs worth at least FEEDBACK_MIN_USDC; smaller ones come back in
   * RoundResult.deferredFeedback for the caller to publish in a batch.
   */
  publishFeedback?: "auto" | "always" | "never";
}

export interface RoundResult {
  chose: Hex | null;
  scores: { address: string; score: number }[];
  outcome: "success" | "fail" | "skipped";
  tx?: Hex;
  receiptHash?: Hex;
  /** true when ERC-8004 feedback was included in the settlement transaction. */
  feedbackPublished?: boolean;
  /** Set when deferSettlement is on: pass to settleBatch to settle several rounds at once. */
  pending?: Call3[];
  /** Set when the job was too small to publish inline — collect and publishFeedbackBatch. */
  deferredFeedback?: FeedbackInput;
}

const transport = () => fallback(RPC_URLS.map((u) => http(u, { retryCount: 4, retryDelay: 1500 })));

async function post(url: string, body: unknown, timeoutMs = 8000): Promise<{ ok: boolean; status: number; body: unknown }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

// One full buy-round. Exported so the demo/E2E can drive and assert on it.
// `pick` selects the pick-th best scored provider (0 = exploit the top; >0 =
// ε-exploration of a runner-up — how a real agent keeps honest scores on backups).
export async function runRound(opts: BuyerOptions, jobInput: string, pick = 0): Promise<RoundResult> {
  const { account, nodeUrl, serviceTag, taskRef } = opts;
  const pub = createPublicClient({ chain: arcTestnet, transport: transport() });
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: transport() });

  // 1. reputation-driven selection
  const dirRes = await fetch(`${nodeUrl}/directory?serviceTag=${serviceTag}`);
  const { agents } = (await dirRes.json()) as { agents: { address: string; score: number; metadataURI: string }[] };
  const callable = agents.filter((a) => a.metadataURI.startsWith("http"));
  const scores = callable.map((a) => ({ address: a.address, score: a.score }));
  const top = callable[Math.min(pick, callable.length - 1)];
  if (!top) return { chose: null, scores, outcome: "skipped" };

  const provider = top.address as Hex;
  const jobId = `job-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const requestedAt = Date.now();
  const requestHash = keccak256(toHex(canonicalize({ jobId, input: jobInput })));

  // 2. buy the job
  const job = await post(`${top.metadataURI}/job`, { jobId, input: jobInput, buyer: account.address });
  const ok = job.ok && !!(job.body as { output?: unknown })?.output;
  const served = job.body as { responseHash?: Hex; deliveredAt?: number; latencyMs?: number; priceUsdc?: string } | null;

  const priceUsdc = served?.priceUsdc ?? "0.002"; // provider quote, or list price on failure
  const receipt: Receipt = {
    v: 1,
    who: { buyer: account.address as Hex, provider },
    what: { service: categorySlug(serviceTag), jobId },
    where: { endpoint: top.metadataURI },
    when: { requestedAt, deliveredAt: served?.deliveredAt ?? Date.now() },
    why: { taskRef },
    how: { requestHash, responseHash: served?.responseHash ?? keccak256(toHex("no-response")) },
    howMuch: { usdc: priceUsdc },
    effect: { outcome: ok ? "success" : "fail", latencyMs: served?.latencyMs ?? 0 },
    risk: { dispute: false },
  };

  // 3. co-sign: buyer always; provider only countersigns real successes. A failing
  //    provider won't sign its own failure — the receipt goes out buyer-only, and
  //    recording it still costs the buyer a real payment (defamation isn't free).
  const sigs: SignedReceipt["sigs"] = { buyer: await signReceipt(receipt, account) };
  if (ok) {
    const cs = await post(`${top.metadataURI}/countersign`, { receipt });
    const sig = (cs.body as { sig?: Hex })?.sig;
    if (sig) sigs.provider = sig;
  }
  const signed: SignedReceipt = { receipt, sigs };
  const hash = receiptHash(receipt);

  // 4. publish the receipt off-chain, then settle on-chain
  await post(`${nodeUrl}/receipts`, signed);
  const inner = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [provider, parseUnits(priceUsdc, 6)],
  });
  const memoData = encodeMemoData({
    kind: MEMO_KIND.receipt,
    outcome: receipt.effect.outcome,
    serviceTag,
    receiptHash: hash,
  });
  const memoCall = encodeFunctionData({
    abi: memoAbi,
    functionName: "memo",
    args: [CONTRACTS.usdc, inner, hash, memoData],
  });

  // 5. optionally mirror the receipt into ERC-8004.
  //
  //    This is the expensive half and it earns nothing toward the score: the node ranks
  //    on verified receipts and settled ERC-8183 jobs, never on registry feedback.
  //    Measured marginal cost per job — Memo anchor $0.0004, giveFeedback $0.00274.
  //    Paying $0.00274 to broadcast a $0.002 job is indefensible, so below
  //    FEEDBACK_MIN_USDC the entry is returned for the caller to publish in a batch
  //    later (publishFeedbackBatch) instead of being charged to the job.
  //
  //    Attribution is checked either way: publishing a real receipt under someone
  //    else's agentId is the one lie the registry cannot catch on its own.
  const agentId = opts.agentIds?.[provider.toLowerCase()];
  let feedbackCall: Hex | undefined;
  let attributed = false;
  let deferredFeedback: FeedbackInput | undefined;
  if (agentId) {
    attributed = await agentOwnsAddress(BigInt(agentId), provider);
    if (attributed) {
      const entry: FeedbackInput = {
        agentId: BigInt(agentId),
        outcome: receipt.effect.outcome,
        service: receipt.what.service,
        endpoint: receipt.where.endpoint,
        feedbackURI: `${nodeUrl}/receipts/${hash}`,
        receiptHash: hash,
      };
      const worthPublishingNow = opts.publishFeedback === "always"
        || (opts.publishFeedback !== "never" && Number(priceUsdc) >= FEEDBACK_MIN_USDC);
      if (worthPublishingNow) feedbackCall = encodeFeedback(entry);
      else deferredFeedback = entry;
    } else {
      console.warn(`[buyer] agentId ${agentId} does not belong to ${provider} — feedback skipped`);
    }
  }

  // Payment and feedback go out as ONE transaction through Multicall3From, which
  // preserves msg.sender so the buyer still pays and still authors the feedback.
  // Atomic on purpose: two separate transactions could leave a payment anchored with
  // no feedback, or the reverse.
  const calls = settlementCalls(memoCall, feedbackCall);

  // Batching mode: hand the calls back and let the caller settle several jobs in one
  // transaction. The provider is paid later, which is the trade — worth it for
  // high-frequency micro-jobs, wrong for large ones, so it is opt-in per buyer.
  if (opts.deferSettlement) {
    return { chose: provider, scores, outcome: ok ? "success" : "fail", receiptHash: hash, feedbackPublished: !!feedbackCall, pending: calls, deferredFeedback };
  }

  const tx = await wallet.writeContract({
    address: CONTRACTS.multicall3From,
    abi: multicall3FromAbi,
    functionName: "aggregate3",
    args: [calls],
  });
  await pub.waitForTransactionReceipt({ hash: tx });

  return { chose: provider, scores, outcome: ok ? "success" : "fail", tx, receiptHash: hash, feedbackPublished: !!feedbackCall, deferredFeedback };
}

export interface Call3 {
  target: Hex;
  allowFailure: boolean;
  callData: Hex;
}

function settlementCalls(memoCall: Hex, feedbackCall?: Hex): Call3[] {
  return [
    { target: CONTRACTS.memo as Hex, allowFailure: false, callData: memoCall },
    ...(feedbackCall ? [{ target: ERC8004.reputation as Hex, allowFailure: false, callData: feedbackCall }] : []),
  ];
}

/**
 * Settle several deferred rounds in ONE transaction.
 *
 * Anchoring costs ~$0.0017 of gas on a job that may only be worth $0.002 — an ~85%
 * surcharge that is the first thing anyone will object to. Batching amortises the
 * fixed cost: six receipts measured at ~$0.00075 each, about 2.2x cheaper. Each memo
 * still wraps its own transfer, so per-job payment-to-proof binding survives intact;
 * the only thing given up is settlement latency.
 */
export async function settleBatch(account: Account, calls: Call3[]): Promise<Hex> {
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: transport() });
  const pub = createPublicClient({ chain: arcTestnet, transport: transport() });
  const tx = await wallet.writeContract({
    address: CONTRACTS.multicall3From,
    abi: multicall3FromAbi,
    functionName: "aggregate3",
    args: [calls],
  });
  await pub.waitForTransactionReceipt({ hash: tx });
  return tx;
}
