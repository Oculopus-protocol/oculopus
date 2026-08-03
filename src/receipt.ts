// The Oculopus receipt: one job = one 5W2H1E1R record, co-signed EIP-712 by both
// sides (plus an optional gateway witness), hashed into the on-chain memo.
//
// On-chain/off-chain split:
//   - memoId  = keccak256(canonical JSON of the receipt, sigs excluded) — the indexed
//     topic in Arc's Memo event, verified live in verifyMemo.ts.
//   - memoData = 12-byte OCU1 blob (magic|kind|outcome|serviceTag|jobIdHint).
//   - The full receipt JSON + signatures live off-chain, keyed by memoId; anyone can
//     re-verify: recover signers over the typed data, re-hash the canonical JSON,
//     compare with the memoId the payment transaction committed to.
import {
  keccak256,
  toHex,
  concatHex,
  parseUnits,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type Account,
} from "viem";
import { CHAIN_ID } from "./config.js";

// ---------------------------------------------------------------- receipt shape --
export type Outcome = "success" | "fail" | "partial";

export interface Receipt {
  v: 1;
  who: { buyer: Address; provider: Address };
  what: { service: string; jobId: string };
  where: { endpoint: string };
  when: { requestedAt: number; deliveredAt: number }; // unix ms
  why: { taskRef: string };
  how: { requestHash: Hex; responseHash: Hex };
  howMuch: { usdc: string }; // decimal string, e.g. "0.0008"
  effect: { outcome: Outcome; latencyMs: number };
  risk: { dispute: boolean };
}

export interface SignedReceipt {
  receipt: Receipt;
  sigs: { buyer?: Hex; provider?: Hex; witness?: Hex };
}

// ------------------------------------------------------------- canonical + hash --
// Deterministic serialization: keys sorted recursively, no whitespace. The hash of
// this exact string is the receipt's identity on-chain (memoId).
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const body = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
    .join(",");
  return `{${body}}`;
}

export function receiptHash(receipt: Receipt): Hex {
  return keccak256(toHex(canonicalize(receipt)));
}

// ------------------------------------------------------------------ EIP-712 sign --
// Wallet-compatible typed data over the receipt's flat fields. Signing the struct
// (rather than the raw JSON hash) keeps signatures human-inspectable in wallets and
// hardware signers; the JSON hash separately anchors the exact document on-chain.
const OUTCOME_CODE: Record<Outcome, number> = { fail: 0, success: 1, partial: 2 };

export const RECEIPT_DOMAIN = {
  name: "Oculopus Receipt",
  version: "1",
  chainId: CHAIN_ID,
} as const;

export const RECEIPT_TYPES = {
  Receipt: [
    { name: "buyer", type: "address" },
    { name: "provider", type: "address" },
    { name: "service", type: "string" },
    { name: "jobId", type: "string" },
    { name: "endpoint", type: "string" },
    { name: "requestedAt", type: "uint64" },
    { name: "deliveredAt", type: "uint64" },
    { name: "taskRef", type: "string" },
    { name: "requestHash", type: "bytes32" },
    { name: "responseHash", type: "bytes32" },
    { name: "usdcAmount", type: "uint256" }, // base units, 6 decimals
    { name: "outcome", type: "uint8" },
    { name: "latencyMs", type: "uint32" },
    { name: "dispute", type: "bool" },
  ],
} as const;

export function receiptTypedMessage(r: Receipt) {
  return {
    buyer: r.who.buyer,
    provider: r.who.provider,
    service: r.what.service,
    jobId: r.what.jobId,
    endpoint: r.where.endpoint,
    requestedAt: BigInt(r.when.requestedAt),
    deliveredAt: BigInt(r.when.deliveredAt),
    taskRef: r.why.taskRef,
    requestHash: r.how.requestHash,
    responseHash: r.how.responseHash,
    usdcAmount: parseUnits(r.howMuch.usdc, 6),
    outcome: OUTCOME_CODE[r.effect.outcome],
    latencyMs: r.effect.latencyMs,
    dispute: r.risk.dispute,
  };
}

export async function signReceipt(receipt: Receipt, account: Account): Promise<Hex> {
  if (!account.signTypedData) throw new Error("account cannot sign typed data");
  return account.signTypedData({
    domain: RECEIPT_DOMAIN,
    types: RECEIPT_TYPES,
    primaryType: "Receipt",
    message: receiptTypedMessage(receipt),
  });
}

export async function recoverReceiptSigner(receipt: Receipt, signature: Hex): Promise<Address> {
  return recoverTypedDataAddress({
    domain: RECEIPT_DOMAIN,
    types: RECEIPT_TYPES,
    primaryType: "Receipt",
    message: receiptTypedMessage(receipt),
    signature,
  });
}

export interface Verification {
  hash: Hex; // memoId this receipt anchors to
  buyerSigned: boolean;
  providerSigned: boolean;
  witness: Address | null; // recovered witness address, if a witness sig is present
}

// Full off-chain verification an indexer runs on a fetched receipt. Signature
// recovery never throws on a well-formed sig — a wrong signer just won't match.
export async function verifySignedReceipt(signed: SignedReceipt): Promise<Verification> {
  const { receipt, sigs } = signed;
  const [buyerAddr, providerAddr, witnessAddr] = await Promise.all([
    sigs.buyer ? recoverReceiptSigner(receipt, sigs.buyer) : null,
    sigs.provider ? recoverReceiptSigner(receipt, sigs.provider) : null,
    sigs.witness ? recoverReceiptSigner(receipt, sigs.witness) : null,
  ]);
  return {
    hash: receiptHash(receipt),
    buyerSigned: !!buyerAddr && buyerAddr.toLowerCase() === receipt.who.buyer.toLowerCase(),
    providerSigned: !!providerAddr && providerAddr.toLowerCase() === receipt.who.provider.toLowerCase(),
    witness: witnessAddr,
  };
}

// ------------------------------------------------------------ OCU1 memoData blob --
// 12 bytes: magic "OCU1" (4) | kind (1) | outcome (1) | serviceTag (2, BE) |
// jobIdHint (4) = first 4 bytes of the receipt hash. Compact tags for cheap on-chain
// filtering; the memoId topic carries the full hash.
export const MEMO_MAGIC = "0x4f435531" as const; // "OCU1"
export const MEMO_KIND = { receipt: 1, dispute: 2 } as const;

export interface MemoTags {
  kind: number;
  outcome: Outcome;
  serviceTag: number; // uint16
  jobIdHint: Hex; // 4 bytes
}

export function encodeMemoData(tags: Omit<MemoTags, "jobIdHint"> & { receiptHash: Hex }): Hex {
  if (tags.serviceTag < 0 || tags.serviceTag > 0xffff) throw new Error("serviceTag out of uint16 range");
  const kind = toHex(tags.kind, { size: 1 });
  const outcome = toHex(OUTCOME_CODE[tags.outcome], { size: 1 });
  const service = toHex(tags.serviceTag, { size: 2 });
  const hint = tags.receiptHash.slice(0, 10) as Hex; // 0x + 4 bytes
  return concatHex([MEMO_MAGIC, kind, outcome, service, hint]);
}

const CODE_OUTCOME: Record<number, Outcome> = { 0: "fail", 1: "success", 2: "partial" };

export function decodeMemoData(data: Hex): MemoTags | null {
  if (!data.toLowerCase().startsWith(MEMO_MAGIC) || data.length !== 2 + 24) return null; // 12 bytes
  const kind = parseInt(data.slice(10, 12), 16);
  const outcomeCode = parseInt(data.slice(12, 14), 16);
  const serviceTag = parseInt(data.slice(14, 18), 16);
  const outcome = CODE_OUTCOME[outcomeCode];
  if (!outcome) return null;
  return { kind, outcome, serviceTag, jobIdHint: `0x${data.slice(18, 26)}` as Hex };
}
