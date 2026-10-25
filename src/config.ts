// Arc network constants. Addresses verified against docs.arc.io (contract-addresses)
// and the Memo ABI fetched from the verified contract on testnet.arcscan.app.
import { defineChain } from "viem";

// Which Arc network this process talks to. Defaults to testnet so an existing
// deployment keeps its behaviour untouched; set OCULOPUS_NETWORK=mainnet to run
// a second node against chain 5042. Receipts stay separate by construction: the
// EIP-712 domain carries chainId, so a mainnet receipt hashes differently and can
// never be scored against testnet history.
export const NETWORK = (process.env.OCULOPUS_NETWORK ?? "testnet").toLowerCase();
if (NETWORK !== "testnet" && NETWORK !== "mainnet") {
  throw new Error(`OCULOPUS_NETWORK must be "testnet" or "mainnet" — got "${NETWORK}"`);
}

const NETWORKS = {
  testnet: {
    chainId: 5042002,
    name: "Arc Testnet",
    // rpc.testnet.arc.io is the domain the docs now use; .arc.network still
    // resolves to the same chain and is kept as a fallback.
    rpc: ["https://rpc.testnet.arc.io", "https://rpc.testnet.arc.network", "https://5042002.rpc.thirdweb.com"],
    explorer: { name: "ArcScan", url: "https://testnet.arcscan.app" },
    // Oldest block worth scanning: the first Oculopus receipt was anchored here.
    genesisScanBlock: 52304155,
    // ERC-8004 / ERC-8183 are community deployments, not Arc predeploys. Confirmed
    // with eth_getCode: they exist on testnet and have no code on mainnet, so a
    // mainnet node must skip those rails rather than read into an empty address.
    registries: true,
  },
  mainnet: {
    chainId: 5042,
    name: "Arc",
    rpc: ["https://rpc.mainnet.arc.io"],
    explorer: { name: "Arc Explorer", url: "https://explorer.arc.io" },
    // Public mainnet head when Oculopus started anchoring — nothing of ours exists
    // before it, and backfilling 22M blocks would be pointless. Override with
    // OCULOPUS_START_BLOCK if you need a different floor.
    genesisScanBlock: 22265141,
    registries: false,
  },
} as const;

const net = NETWORKS[NETWORK as keyof typeof NETWORKS];

export const CHAIN_ID = net.chainId; // guard every send against this
/** ERC-8004 identity/validation + ERC-8183 jobs only exist on testnet. */
export const HAS_REGISTRIES: boolean = net.registries;

export const arcChain = defineChain({
  id: net.chainId,
  name: net.name,
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [net.rpc[0]] } },
  blockExplorers: { default: net.explorer },
});

// The official RPC rate-limits bursts ("request limit reached", -32011) — confirmed
// live. Callers should build transports as fallback(RPC_URLS.map(u => http(u))) and
// keep reads sequential rather than Promise.all bursts.
//
// The public endpoints below return HTTP 429 hard enough to stall a backfill. An
// operator running a node should prepend a keyed endpoint (a free thirdweb client id
// makes it https://5042002.rpc.thirdweb.com/<CLIENT_ID>) via OCULOPUS_RPC_URLS,
// comma-separated; those are tried first, with the public ones kept as fallback.
//
// The override is per-network on purpose: a keyed *testnet* endpoint must never land
// in front of the mainnet list, or the chainId guard rejects the node at startup.
// Mainnet reads OCULOPUS_RPC_URLS_MAINNET; testnet keeps the original variable, so an
// existing .env / systemd unit is untouched.
const OPERATOR_ENV = NETWORK === "mainnet" ? "OCULOPUS_RPC_URLS_MAINNET" : "OCULOPUS_RPC_URLS";
const OPERATOR_RPCS = (process.env[OPERATOR_ENV] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
export const RPC_URLS: readonly string[] = [...OPERATOR_RPCS, ...net.rpc];

// Predeploys. Verified live with eth_getCode: identical bytecode at identical
// addresses on both Arc mainnet and Arc testnet.
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

// Oldest block worth scanning. A node with no OCULOPUS_START_BLOCK replays from here.
export const GENESIS_SCAN_BLOCK = net.genesisScanBlock;
