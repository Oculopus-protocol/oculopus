// Autonomous "credit check before a deal" — the Agentic Economy demo, no human in the loop.
//
//   npm run agent:creditcheck -- 0x<counterparty>     (defaults to a demo provider)
//
// The agent is about to hire a counterparty. Before committing it pays a fraction of a
// cent in USDC over x402 / Circle Gateway to the Oculopus oracle, reads the counterparty's
// credit tier, and decides on its own whether to proceed. It tops up its own Gateway
// balance from its wallet if needed. Nobody clicks anything.
import "dotenv/config";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { RPC_URLS } from "../config.js";

const ORACLE = process.env.ORACLE_URL ?? `http://localhost:${process.env.ORACLE_PORT ?? 8791}`;
const PK = process.env.BUYER_PRIVATE_KEY as `0x${string}` | undefined;
const DEPOSIT_USDC = process.env.GATEWAY_DEPOSIT_USDC ?? "0.05"; // one-time top-up ≈ 500 calls
const MIN_TIER = (process.env.CREDIT_MIN_TIER ?? "SILVER").toUpperCase();
const counterparty = (process.argv[2] ?? "0x2f81ba0d7cc4e9a5301bb6f2a7e4419c8d0a5b3e").toLowerCase();

const TIER_RANK: Record<string, number> = { UNRATED: 0, BRONZE: 1, SILVER: 2, GOLD: 3, PLATINUM: 4 };
const log = (...a: unknown[]) => console.log("[agent]", ...a);

if (!PK) throw new Error("Set BUYER_PRIVATE_KEY in .env (a funded Arc-testnet wallet).");
if (!/^0x[0-9a-fA-F]{40}$/.test(counterparty)) throw new Error(`bad counterparty address: ${counterparty}`);

async function main(): Promise<void> {
  // RPC_URLS[0] is a keyed endpoint when OCULOPUS_RPC_URLS is set, else the public Arc RPC
  // (which rate-limits hard once a node is also reading it — set a keyed one).
  const gw = new GatewayClient({ chain: "arcTestnet", privateKey: PK!, rpcUrl: RPC_URLS[0] });
  log("wallet", gw.address, "· checking counterparty", counterparty);

  // 1. Fund the agent's own Gateway balance if it can't cover a call — the agent managing
  //    its own money, which is the whole point of the track.
  const bal = await gw.getBalances();
  log(`gateway available ${bal.gateway.formattedAvailable} USDC · wallet ${bal.wallet.formatted} USDC`);
  if (bal.gateway.available < 1000n) {
    if (Number(bal.wallet.formatted) < Number(DEPOSIT_USDC)) {
      log(`gateway too low and wallet holds only ${bal.wallet.formatted} USDC — fund it at https://faucet.circle.com`);
      process.exit(1);
    }
    log(`topping up Gateway with ${DEPOSIT_USDC} USDC (one-time)…`);
    const dep = await gw.deposit(DEPOSIT_USDC);
    log(`deposited ${dep.formattedAmount} USDC (tx ${dep.depositTxHash})`);
  }

  // 2. Pay-per-call credit check. GatewayClient.pay handles the whole 402 → sign → retry.
  log("querying Oculopus oracle (pay-per-call)…");
  const payP = gw.pay<{ address: string; score: number; creditTier: string }>(`${ORACLE}/oracle/${counterparty}`);
  const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("PAY_TIMEOUT")), 30_000));
  const { data, formattedAmount, transaction } = await Promise.race([payP, timeout]);
  log(`paid ${formattedAmount} USDC · settlement ${transaction}`);
  log(`oracle → score ${data.score} · tier ${data.creditTier}`);

  // 3. Decide, on its own.
  const meets = (TIER_RANK[data.creditTier] ?? 0) >= (TIER_RANK[MIN_TIER] ?? 2);
  log(
    meets
      ? `DECISION: proceed — ${data.creditTier} meets the ${MIN_TIER}+ bar. Hiring ${counterparty}.`
      : `DECISION: decline / require escrow — ${data.creditTier} is below the ${MIN_TIER}+ bar.`,
  );
}

main().catch((e: unknown) => {
  const err = e as { message?: string; code?: unknown; cause?: { code?: unknown } };
  const code = err?.cause?.code ?? err?.code;
  const s = String(err?.message ?? e);
  if (code === "ECONNREFUSED") {
    log(`cannot reach the oracle at ${ORACLE} — start it in another terminal:  npm run oracle`);
  } else if (code === -32005 || /rate limit|exceeds defined limit/i.test(s)) {
    log("Arc RPC rate-limited. Put a keyed endpoint first via OCULOPUS_RPC_URLS in .env —");
    log("e.g. free thirdweb: OCULOPUS_RPC_URLS=https://5042002.rpc.thirdweb.com/<CLIENT_ID> — then retry.");
  } else if (s.includes("PAY_TIMEOUT")) {
    log("payment/settlement timed out (30s). Check the oracle terminal (T2), and that the node (T1) is");
    log("up and past backfill. Fastest fix: set OCULOPUS_START_BLOCK near head + `npm run seed`, restart node.");
  } else {
    log("failed:", s);
  }
  process.exit(1);
});
