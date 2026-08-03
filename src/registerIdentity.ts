// Register agent wallets in Arc's ERC-8004 IdentityRegistry.
//
// This replaces OculopusRegistry, which reinvented what the chain already
// standardises. An agentId here is an ERC-721 token owned by the agent's wallet:
// one global identity, readable by any ERC-8004 consumer, not just by us.
//
// Run: npm run register:identity
// Writes data/identities.json (gitignored) mapping wallet -> agentId.
import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createPublicClient, createWalletClient, fallback, http, parseEventLogs, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, CHAIN_ID, RPC_URLS } from "./config.js";
import { ERC8004, identityAbi } from "./erc8004.js";

// Deliberately NOT OCULOPUS_STATE_DIR: that points at a fresh per-run directory in
// the demo, while an agentId is a persistent identity that outlives any single run.
const STATE_DIR = "data";
const IDENTITIES_PATH = `${STATE_DIR}/identities.json`;

export interface Identity {
  address: string;
  agentId: string;
  agentURI: string;
  /** Base HTTP endpoint the agent serves from (agentURI may point at its agent card). */
  endpoint: string;
  serviceTag: number;
}

const transport = () => fallback(RPC_URLS.map((u) => http(u, { retryCount: 4, retryDelay: 1500 })));
const pub = createPublicClient({ chain: arcTestnet, transport: transport() });

export function loadIdentities(): Identity[] {
  return existsSync(IDENTITIES_PATH) ? (JSON.parse(readFileSync(IDENTITIES_PATH, "utf8")) as Identity[]) : [];
}

/** Registers the wallet if it has no agentId yet; returns the agentId either way. */
export async function ensureIdentity(privateKey: Hex, agentURI: string, endpoint: string, serviceTag: number): Promise<Identity> {
  const account = privateKeyToAccount(privateKey);
  const existing = loadIdentities().find((i) => i.address.toLowerCase() === account.address.toLowerCase());
  if (existing) {
    // Trust nothing on disk: confirm the chain still agrees this wallet owns it.
    const owner = await pub.readContract({
      address: ERC8004.identity,
      abi: identityAbi,
      functionName: "ownerOf",
      args: [BigInt(existing.agentId)],
    });
    if (owner.toLowerCase() === account.address.toLowerCase()) {
      // Already minted; keep the agentId but refresh the local routing fields.
      return save({ ...existing, agentURI, endpoint, serviceTag });
    }
    console.warn(`[identity] ${account.address} no longer owns agentId ${existing.agentId} — re-registering`);
  }

  const wallet = createWalletClient({ account, chain: arcTestnet, transport: transport() });
  const hash = await wallet.writeContract({
    address: ERC8004.identity,
    abi: identityAbi,
    functionName: "register",
    args: [agentURI],
  });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`register() reverted: ${hash}`);

  const [ev] = parseEventLogs({ abi: identityAbi, eventName: "Registered", logs: rc.logs });
  if (!ev) throw new Error(`no Registered event in ${hash}`);
  const identity = save({
    address: account.address,
    agentId: String(ev.args.agentId),
    agentURI,
    endpoint,
    serviceTag,
  });
  console.log(`[identity] ${account.address} → agentId ${identity.agentId}  tx ${hash}`);
  return identity;
}

function save(identity: Identity): Identity {
  const all = loadIdentities().filter((i) => i.address.toLowerCase() !== identity.address.toLowerCase());
  all.push(identity);
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(IDENTITIES_PATH, JSON.stringify(all, null, 2));
  return identity;
}

async function main() {
  const chainId = await pub.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`RPC chainId ${chainId} != ${CHAIN_ID}`);

  const buyerKey = process.env.BUYER_PRIVATE_KEY as Hex | undefined;
  if (!buyerKey) throw new Error("BUYER_PRIVATE_KEY not set");

  const wallets = JSON.parse(readFileSync(`${STATE_DIR}/demo-wallets.json`, "utf8")) as
    | { providers: { key: Hex; port: number }[] }[]
    | { providers: { key: Hex; port: number }[] };
  const providers = (Array.isArray(wallets) ? wallets[0]! : wallets).providers;

  await ensureIdentity(buyerKey, "https://oculopus.xyz/agents/buyer", "https://oculopus.xyz", 0);
  for (const p of providers) {
    const endpoint = `http://127.0.0.1:${p.port}`;
    await ensureIdentity(p.key, `${endpoint}/agent-card.json`, endpoint, 1);
  }

  console.log(`\nIdentityRegistry ${ERC8004.identity}`);
  for (const i of loadIdentities()) console.log(`  agentId ${i.agentId.padEnd(8)} ${i.address}  service ${i.serviceTag}`);
}

if (process.argv[1]?.endsWith("registerIdentity.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
