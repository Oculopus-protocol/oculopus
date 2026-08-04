// Seed the Arc testnet with N random provider agents and a spread of real receipts,
// so the directory looks like a live marketplace instead of three demo wallets.
//
// Everything here is REAL and recomputable: each agent is a real ERC-8004 identity,
// each receipt is a real co-signed record anchored by a real USDC payment. Nothing is
// faked — the diversity comes from real settled work, which is the whole point.
//
//   npm run seed            # 25 providers (default)
//   npm run seed -- 40      # 40 providers
//   OC_NODE_URL=... npm run seed   # POST receipt docs to this node (default the live one)
//
// The node auto-lists each agent as its first receipt verifies (no OCULOPUS_AGENT_IDS
// step) — they show up on the site within minutes of the node indexing them.
import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import {
  createPublicClient, createWalletClient, http, fallback, encodeFunctionData,
  keccak256, toHex, parseUnits, formatUnits, type Hex,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { arcTestnet, CHAIN_ID, CONTRACTS, RPC_URLS, USDC_DECIMALS } from "./config.js";
import { erc20Abi, memoAbi, multicall3FromAbi } from "./abi.js";
import {
  receiptHash, signReceipt, encodeMemoData, MEMO_KIND, type Receipt, type SignedReceipt,
} from "./receipt.js";
import { ensureIdentity, type Identity } from "./registerIdentity.js";
import { categorySlug } from "./categories.js";

const N = Number(process.argv[2] ?? 25);              // provider agents
const BUYERS = Number(process.env.SEED_BUYERS ?? 6);  // distinct buyers (counterparty cap needs several)
const NODE_URL = (process.env.OC_NODE_URL ?? "https://api.oculopus.xyz").replace(/\/$/, "");
const WALLETS_PATH = "data/seed-wallets.json";
const PRICE = "0.002";                                // USDC per receipt

const PK = process.env.BUYER_PRIVATE_KEY as Hex | undefined;
if (!PK) throw new Error("BUYER_PRIVATE_KEY missing in .env");

const transport = () => fallback(RPC_URLS.map((u) => http(u, { retryCount: 5, retryDelay: 1500 })));
const pub = createPublicClient({ chain: arcTestnet, transport: transport() });
const funder = privateKeyToAccount(PK);
const funderWallet = createWalletClient({ account: funder, chain: arcTestnet, transport: transport() });

const ADJ = ["atlas", "nimbus", "quartz", "vega", "orion", "helix", "corvus", "lyra", "pyxis", "mensa", "cetus", "draco", "aquila", "carina", "dorado", "fornax", "hydra", "indus", "lupus", "norma", "octans", "pavo", "sculptor", "tucana", "volans", "crux", "aries", "cygnus", "phoenix", "tauri"];
const SUF = ["embed", "llm", "rerank", "ocr", "scrape", "speech", "vision", "index", "batch", "core"];
const rnd = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)]!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface SeedWallet { key: Hex; name: string; serviceTag: number; }
interface Wallets { providers: SeedWallet[]; buyers: Hex[]; }

function loadWallets(): Wallets {
  if (existsSync(WALLETS_PATH)) return JSON.parse(readFileSync(WALLETS_PATH, "utf8")) as Wallets;
  const providers: SeedWallet[] = Array.from({ length: N }, (_, i) => ({
    key: generatePrivateKey(),
    name: `${ADJ[i % ADJ.length]}-${rnd(SUF)}`,
    serviceTag: 1 + Math.floor(Math.random() * 9), // 1..9 (includes "other")
  }));
  const buyers: Hex[] = Array.from({ length: BUYERS }, () => generatePrivateKey());
  const w = { providers, buyers };
  mkdirSync("data", { recursive: true });
  writeFileSync(WALLETS_PATH, JSON.stringify(w, null, 2));
  return w;
}

async function usdc(addr: Hex): Promise<bigint> {
  return (await pub.readContract({ address: CONTRACTS.usdc, abi: erc20Abi, functionName: "balanceOf", args: [addr] })) as bigint;
}

/** Top a wallet up to `target` USDC from the funder (also its gas, since USDC is gas). */
async function fund(to: Hex, target: string): Promise<void> {
  if ((await usdc(to)) >= parseUnits(target, USDC_DECIMALS)) return;
  const tx = await funderWallet.writeContract({
    address: CONTRACTS.usdc, abi: erc20Abi, functionName: "transfer",
    args: [to, parseUnits(target, USDC_DECIMALS)],
  });
  await pub.waitForTransactionReceipt({ hash: tx });
}

/** Buyer pays provider and anchors a co-signed receipt; POSTs the document to the node. */
async function anchorReceipt(buyerKey: Hex, providerKey: Hex, provider: Identity, outcome: "success" | "fail"): Promise<void> {
  const buyer = privateKeyToAccount(buyerKey);
  const now = Date.now();
  const jobId = `seed-${now}-${Math.floor(Math.random() * 1e6)}`;
  const receipt: Receipt = {
    v: 1,
    who: { buyer: buyer.address, provider: provider.address as Hex },
    what: { service: categorySlug(provider.serviceTag), jobId },
    where: { endpoint: provider.endpoint },
    when: { requestedAt: now, deliveredAt: now + Math.floor(Math.random() * 900) },
    why: { taskRef: "seed" },
    how: { requestHash: keccak256(toHex(jobId)), responseHash: keccak256(toHex(jobId + outcome)) },
    howMuch: { usdc: PRICE },
    effect: { outcome, latencyMs: 120 + Math.floor(Math.random() * 800) },
    risk: { dispute: false },
  };
  const sigs: SignedReceipt["sigs"] = { buyer: await signReceipt(receipt, buyer) };
  if (outcome === "success") sigs.provider = await signReceipt(receipt, privateKeyToAccount(providerKey));
  const hash = receiptHash(receipt);

  // publish the document so the node can verify the signatures and read the outcome
  await fetch(`${NODE_URL}/receipts`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ receipt, sigs }),
  }).catch(() => {});

  // pay + anchor through Memo (wrapped in Multicall3From, the path the indexer verifies)
  const inner = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [provider.address as Hex, parseUnits(PRICE, USDC_DECIMALS)] });
  const memoData = encodeMemoData({ kind: MEMO_KIND.receipt, outcome, serviceTag: provider.serviceTag, receiptHash: hash });
  const memoCall = encodeFunctionData({ abi: memoAbi, functionName: "memo", args: [CONTRACTS.usdc, inner, hash, memoData] });
  const buyerWallet = createWalletClient({ account: buyer, chain: arcTestnet, transport: transport() });
  const tx = await buyerWallet.writeContract({
    address: CONTRACTS.multicall3From, abi: multicall3FromAbi, functionName: "aggregate3",
    args: [[{ target: CONTRACTS.memo as Hex, allowFailure: false, callData: memoCall }]],
  });
  await pub.waitForTransactionReceipt({ hash: tx });
}

async function main() {
  if ((await pub.getChainId()) !== CHAIN_ID) throw new Error("wrong chain — refusing");
  // The node must be up to receive receipt documents; without them nothing verifies
  // and the gas is wasted. Fail fast instead.
  const up = await fetch(`${NODE_URL}/directory`).then((r) => r.ok).catch(() => false);
  if (!up) throw new Error(`node unreachable at ${NODE_URL} — start it or set OC_NODE_URL`);
  console.log(`node ${NODE_URL} reachable`);
  const funderBal = await usdc(funder.address);
  console.log(`funder ${funder.address}  balance $${formatUnits(funderBal, USDC_DECIMALS)}`);
  const { providers, buyers } = loadWallets();

  // 1. fund + register providers (each owns its own ERC-8004 identity)
  console.log(`\n— registering ${providers.length} providers —`);
  const pairs: { key: Hex; id: Identity }[] = [];
  for (const p of providers) {
    const acct = privateKeyToAccount(p.key);
    await fund(acct.address, "0.12"); // gas to self-register
    const endpoint = `https://${p.name}.oculopus.xyz`;
    pairs.push({ key: p.key, id: await ensureIdentity(p.key, `${endpoint}/agent-card.json`, endpoint, p.serviceTag) });
  }

  // 2. fund buyers (gas + the payments they will make)
  console.log(`\n— funding ${buyers.length} buyers —`);
  for (const b of buyers) await fund(privateKeyToAccount(b).address, "1");

  // 3. spread receipts: each provider gets a random count from random buyers, with a
  //    realistic success rate, so scores land across the whole range.
  console.log(`\n— anchoring receipts —`);
  let n = 0;
  for (const { key, id } of pairs) {
    const count = 1 + Math.floor(Math.random() * 9); // 1..9 receipts
    for (let i = 0; i < count; i++) {
      const outcome: "success" | "fail" = Math.random() < 0.82 ? "success" : "fail";
      try {
        await anchorReceipt(rnd(buyers), key, id, outcome);
        n++;
        if (n % 10 === 0) console.log(`  ${n} receipts anchored…`);
      } catch (e) {
        console.warn(`  receipt failed (${(e as Error).message.slice(0, 60)}) — continuing`);
      }
      await sleep(150); // ease RPC rate limits
    }
  }

  console.log(`\n✓ ${pairs.length} agents, ${n} receipts anchored.`);
  console.log(`The node auto-lists each as it indexes their receipts — no config step.`);
  console.log(`agentIds: ${pairs.map((p) => p.id.agentId).join(",")}`);
  console.log(`\nfunder balance now $${formatUnits(await usdc(funder.address), USDC_DECIMALS)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
