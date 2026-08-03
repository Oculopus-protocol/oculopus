// End-to-end demo + live verification of the full Oculopus loop on Arc Testnet.
//
//   setup   : 3 provider wallets (generated once, funded from the buyer wallet,
//             identified by their ERC-8004 agentId; see registerIdentity.ts)
//   run     : Oculopus node + 3 provider agents in-process; the buyer agent runs
//             rounds of: pick-by-score → buy → co-sign → publish → pay-with-memo.
//             Every 4th round explores the runner-up (ε-exploration — a real agent
//             pattern; it also seeds honest scores for the alternatives).
//   twist   : mid-run, the top provider is DEGRADED (starts erroring). Its fail
//             receipts anchor on-chain, its score sinks, and the buyer reroutes —
//             autonomously. That reroute is asserted, not eyeballed.
//
// Run: npm run demo   (spends a few cents of testnet USDC on ~a dozen memo txs)
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  http,
  fallback,
  formatUnits,
  parseUnits,
  type Hex,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { arcTestnet, CHAIN_ID, CONTRACTS, RPC_URLS, USDC_DECIMALS } from "./config.js";
import { erc20Abi } from "./abi.js";
import { startProvider, type ProviderHandle } from "./agents/provider.js";
import { runRound, type BuyerOptions } from "./agents/buyer.js";
import { loadIdentities } from "./registerIdentity.js";

const NODE_PORT = process.env.NODE_PORT ?? "8790";
const NODE_URL = `http://127.0.0.1:${NODE_PORT}`;
const SERVICE_TAG = 1;
const PROVIDER_PORTS = [8791, 8792, 8793];
const WALLETS_PATH = "data/demo-wallets.json";

const pk = process.env.BUYER_PRIVATE_KEY as Hex | undefined;
if (!pk) throw new Error("BUYER_PRIVATE_KEY missing in .env");
const buyer = privateKeyToAccount(pk);

const transport = () => fallback(RPC_URLS.map((u) => http(u, { retryCount: 4, retryDelay: 1500 })));
const pub = createPublicClient({ chain: arcTestnet, transport: transport() });
const buyerWallet = createWalletClient({ account: buyer, chain: arcTestnet, transport: transport() });

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- 0. chain guard --------------------------------------------------------------
if ((await pub.getChainId()) !== CHAIN_ID) throw new Error("wrong chain — refusing");

// ---- 1. provider wallets: generate once, fund, register --------------------------
interface DemoWallets {
  providers: { key: Hex; port: number }[];
}
let wallets: DemoWallets;
if (existsSync(WALLETS_PATH)) {
  wallets = JSON.parse(readFileSync(WALLETS_PATH, "utf8")) as DemoWallets;
} else {
  wallets = { providers: PROVIDER_PORTS.map((port) => ({ key: generatePrivateKey(), port })) };
  mkdirSync("data", { recursive: true });
  writeFileSync(WALLETS_PATH, JSON.stringify(wallets, null, 2));
}
const providerAccounts = wallets.providers.map((p) => ({ account: privateKeyToAccount(p.key), port: p.port }));

for (const p of providerAccounts) {
  const bal = (await pub.readContract({
    address: CONTRACTS.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [p.account.address],
  })) as bigint;
  if (bal < parseUnits("0.2", USDC_DECIMALS)) {
    const tx = await buyerWallet.writeContract({
      address: CONTRACTS.usdc,
      abi: erc20Abi,
      functionName: "transfer",
      args: [p.account.address, parseUnits("0.3", USDC_DECIMALS)],
    });
    await pub.waitForTransactionReceipt({ hash: tx });
    console.log(`funded ${p.account.address} with 0.3 USDC (gas money)`);
  }
}

// ---- 2. start the node + provider agents in-process ------------------------------
process.env.OCULOPUS_STATE_DIR = `data/run-${Date.now()}`; // fresh reputation per run
// A throwaway run only cares about the receipts it is about to create, so start the
// indexer near the head instead of replaying every block since the deployment.
process.env.OCULOPUS_START_BLOCK = String(await pub.getBlockNumber());
await import("./node.js");
await sleep(500);

const handles: ProviderHandle[] = providerAccounts.map((p) =>
  startProvider({ port: p.port, account: p.account, priceUsdc: "0.002" }),
);
const short = (a: string) => a.slice(0, 8);
console.log(`providers: ${handles.map((h) => `${short(h.address)}@${h.endpoint.slice(-4)}`).join("  ")}\n`);

// wait for the indexer to pick up the registry listings
for (let i = 0; i < 20; i++) {
  const { agents } = (await (await fetch(`${NODE_URL}/directory?serviceTag=${SERVICE_TAG}`)).json()) as {
    agents: { metadataURI: string }[];
  };
  if (agents.filter((a) => a.metadataURI.startsWith("http")).length >= 3) break;
  await sleep(2000);
}

// ---- 3. buyer rounds -------------------------------------------------------------
// ERC-8004 identities, so every round also publishes standard feedback bound to
// the receipt (see feedback.ts). Missing file = feedback step is skipped.
const agentIds = Object.fromEntries(loadIdentities().map((i) => [i.address.toLowerCase(), i.agentId]));
const opts: BuyerOptions = { account: buyer, nodeUrl: NODE_URL, serviceTag: SERVICE_TAG, taskRef: "demo-e2e", agentIds };

async function waitVerified(hash: Hex): Promise<boolean> {
  for (let i = 0; i < 15; i++) {
    const res = await fetch(`${NODE_URL}/receipts/${hash}`);
    if (res.ok) {
      const body = (await res.json()) as { verified?: unknown };
      if (body.verified) return true;
    }
    await sleep(2000);
  }
  return false;
}

let explorations = 0;
async function round(n: number, explore: boolean) {
  // Rotate exploration across ALL runner-ups (1st, 2nd, …) so every listed provider
  // earns an honest track record — a single fixed explore slot would leave the tail
  // of the directory forever unproven.
  const pick = explore ? 1 + (explorations++ % (PROVIDER_PORTS.length - 1)) : 0;
  const r = await runRound(opts, `input for round ${n}`, pick);
  const scoreStr = r.scores.map((s) => `${short(s.address)}=${s.score.toFixed(1)}`).join(" ");
  console.log(`[round ${String(n).padStart(2)}] ${explore ? "explore" : "exploit"} → ${r.chose ? short(r.chose) : "none"} ${r.outcome}  | ${scoreStr}`);
  if (r.receiptHash) await waitVerified(r.receiptHash);
  return r;
}

console.log("— phase 1: all healthy —");
for (let n = 1; n <= 8; n++) await round(n, n % 4 === 0);

let dir = (await (await fetch(`${NODE_URL}/directory?serviceTag=${SERVICE_TAG}`)).json()) as {
  agents: { address: string; score: number; receipts: number; metadataURI: string }[];
};
let callable = dir.agents.filter((a) => a.metadataURI.startsWith("http"));
check("all 3 providers have on-chain receipts after phase 1", callable.every((a) => a.receipts > 0));
check("phase-1 top earned a score above the 25 prior", (callable[0]?.score ?? 0) > 25, `top=${callable[0]?.score}`);

// ---- 4. the twist: degrade the current top provider ------------------------------
const topAddr = callable[0]!.address.toLowerCase();
const topHandle = handles.find((h) => h.address.toLowerCase() === topAddr)!;
topHandle.degrade();
console.log(`\n— phase 2: DEGRADED ${short(topAddr)} (now errors on every job) —`);

let rerouted: string | null = null;
for (let n = 9; n <= 16; n++) {
  const r = await round(n, false);
  if (r.chose && r.chose.toLowerCase() !== topAddr) {
    rerouted = r.chose.toLowerCase();
    break;
  }
}

check("buyer AUTONOMOUSLY rerouted away from the degraded provider", rerouted !== null, rerouted ? `now buying from ${short(rerouted)}` : "never rerouted");

dir = (await (await fetch(`${NODE_URL}/directory?serviceTag=${SERVICE_TAG}`)).json()) as typeof dir;
callable = dir.agents.filter((a) => a.metadataURI.startsWith("http"));
const degraded = callable.find((a) => a.address.toLowerCase() === topAddr);
check("degraded provider's score collapsed below its replacement", !!rerouted && !!degraded && degraded.score < (callable.find((a) => a.address.toLowerCase() === rerouted)?.score ?? 0), `degraded=${degraded?.score}`);

const agentView = (await (await fetch(`${NODE_URL}/agents/${topAddr}`)).json()) as {
  recentReceipts: { outcome: string; tx: string }[];
};
const failReceipts = agentView.recentReceipts.filter((r) => r.outcome === "fail");
check("fail receipts are anchored on-chain and publicly queryable", failReceipts.length > 0, `${failReceipts.length} fail receipts, e.g. tx ${failReceipts[0]?.tx.slice(0, 14)}…`);

const buyerBal = (await pub.readContract({ address: CONTRACTS.usdc, abi: erc20Abi, functionName: "balanceOf", args: [buyer.address] })) as bigint;
console.log(`\nbuyer balance: $${formatUnits(buyerBal, USDC_DECIMALS)}   dashboard: ${NODE_URL}`);
console.log(`${pass} passed, ${fail} failed`);
for (const h of handles) h.close();
process.exit(fail ? 1 : 0);
