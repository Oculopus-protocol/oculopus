// Seed the x402 rail: co-signed off-chain receipts, batched into ONE Merkle root that is
// anchored with a single Memo transaction on Arc — exactly the flow createOculopusSeller
// uses in production. Lights up rails.x402 for existing seeded agents so the directory
// reflects the off-chain-settled rail, not just the on-chain one.
//
//   OC_NODE_URL=https://api.oculopus.xyz npm run seed:x402        # 8 providers × 2 receipts
//   OC_NODE_URL=https://api.oculopus.xyz npm run seed:x402 -- 12  # 12 providers
//
// Real: signatures, Merkle proofs and the on-chain anchor are all genuine and recomputable.
// The only synthetic field is Circle's settlementId — on testnet there is no Gateway batch
// to read it from; in production the seller middleware fills it from the settle context.
import "dotenv/config";
import {
  createPublicClient, createWalletClient, http, fallback, encodeFunctionData,
  keccak256, toHex, parseUnits, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, CHAIN_ID, CONTRACTS, RPC_URLS, USDC_DECIMALS } from "./config.js";
import { erc20Abi, memoAbi, multicall3FromAbi } from "./abi.js";
import { encodeMemoData, MEMO_KIND } from "./receipt.js";
import { signReceiptHash } from "./x402Client.js";
import { x402ReceiptHash, merkleRoot, merkleProof, ARC_TESTNET_CAIP2, type X402Receipt } from "./x402.js";
import { readFileSync } from "node:fs";
import { categorySlug } from "./categories.js";

const PROVIDERS = Number(process.argv[2] ?? 8); // how many existing agents get x402 receipts
const PER = Number(process.env.SEED_X402_PER ?? 2); // receipts per provider
const NODE_URL = (process.env.OC_NODE_URL ?? "https://api.oculopus.xyz").replace(/\/$/, "");
const PRICE = "0.0002";

const PK = process.env.BUYER_PRIVATE_KEY as Hex | undefined;
if (!PK) throw new Error("BUYER_PRIVATE_KEY missing in .env");

interface SeedWallet { key: Hex; name: string; serviceTag: number; }
interface Wallets { providers: SeedWallet[]; buyers: Hex[]; }
const wallets = JSON.parse(readFileSync("data/seed-wallets.json", "utf8")) as Wallets;

const transport = () => fallback(RPC_URLS.map((u) => http(u, { retryCount: 5, retryDelay: 1500 })));
const pub = createPublicClient({ chain: arcTestnet, transport: transport() });
const funder = privateKeyToAccount(PK);
const funderWallet = createWalletClient({ account: funder, chain: arcTestnet, transport: transport() });
const rnd = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)]!;

interface Pending { receipt: X402Receipt; hash: Hex; providerSig: Hex; buyerSig: Hex; }

async function build(provider: SeedWallet, buyerKey: Hex): Promise<Pending> {
  const providerAcct = privateKeyToAccount(provider.key);
  const buyerAcct = privateKeyToAccount(buyerKey);
  const now = Date.now();
  const jobId = `x402-${now}-${Math.floor(Math.random() * 1e6)}`;
  const outcome: "success" | "fail" = Math.random() < 0.85 ? "success" : "fail";
  const receipt: X402Receipt = {
    v: 1,
    rail: "x402",
    who: { buyer: buyerAcct.address, provider: providerAcct.address },
    what: { service: categorySlug(provider.serviceTag), jobId },
    where: { endpoint: `https://${provider.name}.oculopus.xyz`, network: ARC_TESTNET_CAIP2 },
    when: { requestedAt: now, deliveredAt: now + Math.floor(Math.random() * 600) },
    how: { requestHash: keccak256(toHex(jobId)), responseHash: keccak256(toHex(jobId + outcome)) },
    howMuch: { usdc: PRICE },
    effect: { outcome, latencyMs: 90 + Math.floor(Math.random() * 500) },
    risk: { dispute: false },
    authHash: keccak256(toHex(`auth-${jobId}`)),
    settlementId: `seed-x402-${jobId}`,
  };
  const hash = x402ReceiptHash(receipt);
  return {
    receipt, hash,
    providerSig: await signReceiptHash(providerAcct, hash),
    buyerSig: await signReceiptHash(buyerAcct, hash),
  };
}

/** One Memo tx whose memoId IS the batch root — the anchor the node matches receipts against. */
async function anchorRoot(root: Hex): Promise<Hex> {
  const inner = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [funder.address, 0n] });
  const memoData = encodeMemoData({ kind: MEMO_KIND.receipt, outcome: "success", serviceTag: 0, receiptHash: root });
  const memoCall = encodeFunctionData({ abi: memoAbi, functionName: "memo", args: [CONTRACTS.usdc, inner, root, memoData] });
  const tx = await funderWallet.writeContract({
    address: CONTRACTS.multicall3From, abi: multicall3FromAbi, functionName: "aggregate3",
    args: [[{ target: CONTRACTS.memo as Hex, allowFailure: false, callData: memoCall }]],
  });
  await pub.waitForTransactionReceipt({ hash: tx });
  return tx;
}

async function main() {
  if ((await pub.getChainId()) !== CHAIN_ID) throw new Error("wrong chain — refusing");
  const up = await fetch(`${NODE_URL}/directory`).then((r) => r.ok).catch(() => false);
  if (!up) throw new Error(`node unreachable at ${NODE_URL}`);
  console.log(`node ${NODE_URL} reachable · anchoring 1 batch as ${funder.address}`);

  // 1. build a batch of co-signed x402 receipts across several existing agents
  const chosen = wallets.providers.slice(0, Math.min(PROVIDERS, wallets.providers.length));
  const pend: Pending[] = [];
  for (const p of chosen) for (let i = 0; i < PER; i++) pend.push(await build(p, rnd(wallets.buyers)));
  console.log(`built ${pend.length} x402 receipts across ${chosen.length} agents`);

  // 2. one Merkle root, one on-chain anchor
  const hashes = pend.map((p) => p.hash);
  const root = merkleRoot(hashes);
  const tx = await anchorRoot(root);
  console.log(`anchored root ${root.slice(0, 12)}… tx ${tx.slice(0, 12)}…`);

  // 3. publish each receipt with its proof; the node verifies sigs + proof + the anchor
  let ok = 0;
  for (let i = 0; i < pend.length; i++) {
    const p = pend[i]!;
    const r: { stored?: boolean; anchored?: boolean; error?: string } = await fetch(`${NODE_URL}/x402/receipts`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ receipt: p.receipt, providerSig: p.providerSig, buyerSig: p.buyerSig, root, proof: merkleProof(hashes, i) }),
    }).then((x) => x.json() as Promise<{ stored?: boolean; anchored?: boolean; error?: string }>).catch((e) => ({ error: String(e) }));
    if (r.stored) ok++;
    else console.warn(`  receipt ${i} not stored: ${r.error ?? "unknown"}`);
  }
  console.log(`\n✓ ${ok}/${pend.length} x402 receipts stored. rails.x402 will show on the directory once the node re-reads the anchor.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
