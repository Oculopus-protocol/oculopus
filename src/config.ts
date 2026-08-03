// Arc Testnet constants. Addresses verified against docs.arc.io (contract-addresses)
// and the Memo ABI fetched from the verified contract on testnet.arcscan.app.
import { defineChain } from "viem";

export const CHAIN_ID = 5042002; // Arc Testnet — guard every send against this

export const arcTestnet = defineChain({
  id: CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
  blockExplorers: { default: { name: "ArcScan", url: "https://testnet.arcscan.app" } },
});

// The official RPC rate-limits bursts ("request limit reached", -32011) — confirmed
// live. Callers should build transports as fallback(RPC_URLS.map(u => http(u))) and
// keep reads sequential rather than Promise.all bursts.
//
// The public endpoints below return HTTP 429 hard enough to stall a backfill. An
// operator running a node should prepend a keyed endpoint (a free thirdweb client id
// makes it https://5042002.rpc.thirdweb.com/<CLIENT_ID>) via OCULOPUS_RPC_URLS,
// comma-separated; those are tried first, with the public ones kept as fallback.
const OPERATOR_RPCS = (process.env.OCULOPUS_RPC_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
export const RPC_URLS: readonly string[] = [
  ...OPERATOR_RPCS,
  "https://rpc.testnet.arc.network",
  "https://5042002.rpc.thirdweb.com",
];

export const CONTRACTS = {
  // Native gas token's ERC-20 interface (6 decimals) — predeployed.
  usdc: "0x3600000000000000000000000000000000000000",
  // Transaction extension: wraps a call, preserves msg.sender via the CallFrom
  // precompile, and emits an indexed Memo event. The receipt substrate for Oculopus.
  memo: "0x5294E9927c3306DcBaDb03fe70b92e01cCede505",
  // Batches calls while preserving the original msg.sender. Verified live that
  // nesting works: an aggregate3 wrapping Memo.memo still emits the Memo event with
  // the EOA as sender, not the multicall (tx 0x3955cc8013475b…). That is what lets
  // the payment and its ERC-8004 feedback settle in one atomic transaction.
  multicall3From: "0x522fAf9A91c41c443c66765030741e4AaCe147D0",
} as const;

export const USDC_DECIMALS = 6;

// Oldest block worth scanning: the first Oculopus receipt was anchored here. A node
// with no OCULOPUS_START_BLOCK replays from this point.
export const GENESIS_SCAN_BLOCK = 52304155;
