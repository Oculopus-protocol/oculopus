// Rescore live ERC-8004 agents with the Oculopus model.
//
// This reads REAL feedback already published to Arc testnet's ReputationRegistry
// and recomputes it under our scoring rules. The point it makes:
//
//   ERC-8004 feedback is one signature from the client. Nothing binds it to a
//   payment, and the rated agent never counter-signs. So a registry average
//   treats 100 ratings from one wallet exactly like 100 ratings from 100 wallets.
//   Oculopus caps what any single counterparty can contribute.
//
// The gap between the two columns is concentration, not proof of fraud — this
// prints public data and says nothing about intent.
//
// Honest limit: readAllFeedback() returns no timestamps, so recency decay is NOT
// applied here (every entry is treated as current). Decay applies in the node's
// own indexer, which reads NewFeedback events and has block times.
import { pathToFileURL } from "node:url";
import { createPublicClient, fallback, http } from "viem";
import { arcTestnet, RPC_URLS } from "./config.js";
import { ERC8004, reputationAbi, normaliseRating } from "./erc8004.js";
import { scoreProvider, type ReceiptRecord } from "./scorer.js";

const pub = createPublicClient({
  chain: arcTestnet,
  transport: fallback(RPC_URLS.map((u) => http(u, { retryCount: 4, retryDelay: 1500 }))),
});

// readAllFeedback over 1000+ clients is one huge eth_call; batch the client list.
const CLIENT_BATCH = 150;
/** A rating at or above this counts as a success, below it as a failure. */
const SUCCESS_AT = 0.6;

export interface Rescore {
  agentId: bigint;
  clients: number;
  feedback: number;
  /** Plain mean of every rating, the way a naive registry reader would compute it. */
  rawScore: number;
  /** Oculopus scoring: same entries, per-counterparty contribution capped. */
  cappedScore: number;
  /** Share of all feedback contributed by the single busiest client. */
  topClientShare: number;
  /** Clients whose history was too large to read in one call — excluded, not silently dropped. */
  skippedClients: number;
  /** Feedback entries counted toward concentration but whose ratings were not read. */
  unreadEntries: number;
}

const readFeedbackPage = (agentId: bigint, batch: readonly `0x${string}`[]) =>
  pub.readContract({
    address: ERC8004.reputation,
    abi: reputationAbi,
    functionName: "readAllFeedback",
    args: [agentId, batch, "", "", false],
  });

export async function rescoreAgent(agentId: bigint): Promise<Rescore> {
  const clients = await pub.readContract({
    address: ERC8004.reputation,
    abi: reputationAbi,
    functionName: "getClients",
    args: [agentId],
  });

  const records: ReceiptRecord[] = [];
  const perClient = new Map<string, number>();
  let ratingSum = 0;
  let skipped = 0;
  let unreadEntries = 0;

  for (let i = 0; i < clients.length; ) {
    // A client with thousands of entries makes readAllFeedback exceed the eth_call
    // budget and revert, so shrink the batch until it fits (agentId 1 needs this).
    let size = Math.min(CLIENT_BATCH, clients.length - i);
    let page: Awaited<ReturnType<typeof readFeedbackPage>> | null = null;
    while (size >= 1) {
      try {
        page = await readFeedbackPage(agentId, clients.slice(i, i + size));
        break;
      } catch {
        if (size === 1) break; // one client alone is too big — skip it, counted below
        size = Math.max(1, Math.floor(size / 2));
      }
    }
    if (!page) {
      // Too big to read, but its SIZE still matters: a single client holding most of
      // an agent's feedback is the concentration we are trying to measure. Dropping it
      // silently would report the opposite of the truth. getLastIndex gives the count
      // without returning the payload.
      const client = clients[i]!;
      const count = await pub.readContract({
        address: ERC8004.reputation,
        abi: reputationAbi,
        functionName: "getLastIndex",
        args: [agentId, client],
      });
      perClient.set(client.toLowerCase(), (perClient.get(client.toLowerCase()) ?? 0) + Number(count));
      unreadEntries += Number(count);
      skipped += 1;
      i += 1;
      continue;
    }
    i += size;
    const [cl, , values, decs] = page;
    for (let j = 0; j < cl.length; j++) {
      const rating = normaliseRating(values[j] ?? 0n, decs[j] ?? 0);
      ratingSum += rating;
      const client = (cl[j] ?? "").toLowerCase();
      perClient.set(client, (perClient.get(client) ?? 0) + 1);
      records.push({
        provider: String(agentId),
        buyer: client,
        outcome: rating >= SUCCESS_AT ? "success" : "fail",
        disputed: false,
        witnessed: false,
        deliveredAt: Date.now(), // no timestamp available — see note above
      });
    }
  }

  const busiest = Math.max(0, ...perClient.values());
  const totalEntries = records.length + unreadEntries;
  return {
    agentId,
    clients: clients.length,
    feedback: records.length,
    rawScore: records.length ? Math.round((ratingSum / records.length) * 1000) / 10 : 0,
    cappedScore: scoreProvider(records).score,
    topClientShare: totalEntries ? Math.round((busiest / totalEntries) * 1000) / 10 : 0,
    skippedClients: skipped,
    unreadEntries,
  };
}

async function main() {
  const ids = process.argv.slice(2).map(BigInt);
  if (!ids.length) {
    console.error("usage: npm run rescore -- <agentId> [agentId...]");
    process.exit(2);
  }
  console.log("ERC-8004 ReputationRegistry", ERC8004.reputation, "· Arc testnet\n");
  console.log("agent   clients   feedback   registry avg   Oculopus   top client");
  for (const id of ids) {
    const r = await rescoreAgent(id);
    console.log(
      String(r.agentId).padEnd(8) +
        String(r.clients).padEnd(10) +
        String(r.feedback).padEnd(11) +
        (r.rawScore.toFixed(1) + "%").padEnd(15) +
        r.cappedScore.toFixed(1).padEnd(11) +
        r.topClientShare.toFixed(1) + "%",
    );
    if (r.skippedClients)
      console.log(
        `  note: ${r.skippedClients} client(s) too large to read; ${r.unreadEntries} entries counted for concentration, ratings unread`,
      );
  }
  console.log("\nRegistry avg = plain mean of every rating.");
  console.log("Oculopus = same entries, each counterparty capped at 2.0 effective receipts.");
  console.log("Neither column proves misconduct; the gap measures concentration.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
