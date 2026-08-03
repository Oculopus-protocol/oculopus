// Buyer side of the x402 rail: counter-sign what you were served, and verify a
// provider's claim without asking Oculopus anything.
//
// The buyer already signed the PAYMENT (x402 handles that). Counter-signing is a
// separate, cheap statement about the WORK: "this is what I asked for and this is what
// I got". It is what stops a provider inventing jobs a buyer never made — the same
// property the on-chain rail gets from co-signed receipts.
import {
  createPublicClient,
  fallback,
  http,
  keccak256,
  recoverTypedDataAddress,
  toHex,
  type Account,
  type Address,
  type Hex,
} from "viem";
import { arcTestnet, CONTRACTS, RPC_URLS } from "./config.js";
import { memoAbi } from "./abi.js";
import { canonicalize } from "./receipt.js";
import { verifyMerkleProof, x402ReceiptHash, type X402Receipt } from "./x402.js";
import { RECEIPT_HEADER, SIGNATURE_HEADER } from "./x402Middleware.js";

/** Both sides sign the receipt hash under this domain — one struct, one chain id. */
export const X402_DOMAIN = { name: "Oculopus Receipt", version: "1", chainId: 5042002 } as const;
export const X402_TYPES = { X402Receipt: [{ name: "receiptHash", type: "bytes32" }] } as const;

export function signReceiptHash(account: Account, hash: Hex): Promise<Hex> {
  if (!account.signTypedData) throw new Error("account cannot sign typed data");
  return account.signTypedData({
    domain: X402_DOMAIN,
    types: X402_TYPES,
    primaryType: "X402Receipt",
    message: { receiptHash: hash },
  });
}

export function recoverReceiptSigner(hash: Hex, signature: Hex): Promise<Address> {
  return recoverTypedDataAddress({
    domain: X402_DOMAIN,
    types: X402_TYPES,
    primaryType: "X402Receipt",
    message: { receiptHash: hash },
    signature,
  });
}

/**
 * Fetch a provider's receipt claim by settlement id.
 *
 * The header path below only works for HTTP clients that surface response headers.
 * Circle's `GatewayClient.pay()` does not — it returns `{ data, amount, transaction,
 * status }` — so an x402 buyer asks the provider for the receipt matching the
 * settlement id it got back. Verified against the real client, which returned no
 * headers at all.
 */
export async function fetchClaim(
  endpointBase: string,
  settlementId: string,
): Promise<{ claim: ProviderClaim; receipt: X402Receipt } | null> {
  const res = await fetch(`${endpointBase}/oculopus/receipt/${encodeURIComponent(settlementId)}`);
  if (!res.ok) return null;
  const body = (await res.json()) as { hash?: Hex; signature?: Hex; receipt?: X402Receipt };
  return body.hash && body.signature && body.receipt
    ? { claim: { hash: body.hash, signature: body.signature }, receipt: body.receipt }
    : null;
}

/** What the provider returned alongside the paid response. */
export interface ProviderClaim {
  hash: Hex;
  signature: Hex;
}

/** Pull the provider's receipt claim out of a paid response's headers. */
export function readClaim(headers: { get(name: string): string | null } | Record<string, string | undefined>): ProviderClaim | null {
  const read = (k: string): string | null =>
    typeof (headers as { get?: unknown }).get === "function"
      ? (headers as { get(name: string): string | null }).get(k)
      : ((headers as Record<string, string | undefined>)[k] ?? null);
  const hash = read(RECEIPT_HEADER);
  const signature = read(SIGNATURE_HEADER);
  return hash && signature ? { hash: hash as Hex, signature: signature as Hex } : null;
}

export interface CounterSignResult {
  ok: boolean;
  reason?: string;
  buyerSig?: Hex;
}

/**
 * Check a provider's claim before endorsing it.
 *
 * A buyer that counter-signs whatever it is handed is worse than useless: it turns its
 * own reputation into a rubber stamp. So every field the buyer can independently check
 * is checked, and anything that does not match is refused rather than signed.
 */
export async function counterSign(
  buyer: Account,
  receipt: X402Receipt,
  claim: ProviderClaim,
  expected: { requestBody?: unknown; responseBody?: unknown; maxUsdc?: string },
): Promise<CounterSignResult> {
  if (x402ReceiptHash(receipt) !== claim.hash) {
    return { ok: false, reason: "receipt does not hash to the claimed value" };
  }
  if (receipt.who.buyer.toLowerCase() !== buyer.address.toLowerCase()) {
    return { ok: false, reason: "receipt names a different buyer" };
  }
  const signer = await recoverReceiptSigner(claim.hash, claim.signature);
  if (signer.toLowerCase() !== receipt.who.provider.toLowerCase()) {
    return { ok: false, reason: "signature does not come from the named provider" };
  }
  if (expected.requestBody !== undefined) {
    const want = keccak256(toHex(canonicalize(expected.requestBody)));
    if (receipt.how.requestHash !== want) return { ok: false, reason: "requestHash is not what I sent" };
  }
  if (expected.responseBody !== undefined) {
    const want = keccak256(toHex(canonicalize(expected.responseBody)));
    if (receipt.how.responseHash !== want) return { ok: false, reason: "responseHash is not what I received" };
  }
  if (expected.maxUsdc !== undefined && Number(receipt.howMuch.usdc) > Number(expected.maxUsdc)) {
    return { ok: false, reason: `charged ${receipt.howMuch.usdc}, expected at most ${expected.maxUsdc}` };
  }
  return { ok: true, buyerSig: await signReceiptHash(buyer, claim.hash) };
}

export interface VerifiedAnchor {
  anchored: boolean;
  root?: Hex;
  tx?: Hex;
  block?: bigint;
}

/**
 * Confirm a receipt really is inside a Merkle root that was anchored on Arc.
 *
 * Deliberately reads the chain directly rather than trusting any Oculopus service —
 * this function is what makes "you do not have to trust us" true on this rail.
 */
export async function verifyAnchored(
  receiptHash: Hex,
  proof: Hex[],
  root: Hex,
  opts: { fromBlock?: bigint; toBlock?: bigint } = {},
): Promise<VerifiedAnchor> {
  if (!verifyMerkleProof(receiptHash, proof, root)) return { anchored: false };
  const pub = createPublicClient({
    chain: arcTestnet,
    transport: fallback(RPC_URLS.map((u) => http(u, { retryCount: 4, retryDelay: 1500 }))),
  });
  const head = await pub.getBlockNumber();
  const to = opts.toBlock ?? head;
  const from = opts.fromBlock ?? (to > 999n ? to - 999n : 0n);
  const logs = await pub.getLogs({ address: CONTRACTS.memo, event: memoAbi[2], args: { memoId: root }, fromBlock: from, toBlock: to });
  const log = logs[0];
  return log
    ? { anchored: true, root, tx: log.transactionHash, block: log.blockNumber }
    : { anchored: false, root };
}
