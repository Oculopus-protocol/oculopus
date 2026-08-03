// The Oculopus node — MVP reference implementation of the protocol's read side.
//
// One process, three jobs:
//   1. Receipt store  — agents POST co-signed receipts; anyone can GET them by hash.
//      (Off-chain half of the protocol. The chain holds the hash; this holds the doc.)
//   2. Indexer        — tails Arc for Memo events carrying OCU1 receipts, then runs
//      the full verification chain: stored doc hash == memoId, EIP-712 sigs valid,
//      tx sender == receipt buyer, and the wrapped USDC transfer actually pays the
//      receipt's provider the receipt's amount. Only receipts that survive ALL checks
//      feed reputation. Everything here is recomputable by anyone from public data.
//   3. Directory API + dashboard — scored agent listings the buyer agents query.
//
// Run: npm run node   (http://localhost:8790)
import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { extname } from "node:path";
import {
  createPublicClient,
  formatUnits,
  http,
  fallback,
  parseEventLogs,
  decodeFunctionData,
  parseUnits,
  type Hex,
} from "viem";
import { arcTestnet, CHAIN_ID, CONTRACTS, GENESIS_SCAN_BLOCK, RPC_URLS } from "./config.js";
import { memoAbi, erc20Abi, multicall3FromAbi } from "./abi.js";
import { verifySignedReceipt, receiptHash, decodeMemoData, type SignedReceipt } from "./receipt.js";
import { scoreProvider, scoreBuyer, propagate, type ReceiptRecord, type ScoreBreakdown } from "./scorer.js";
import { ERC8183, jobAbi, hasIndependentEvaluator } from "./erc8183.js";
import { categoryLabel, categorySlug, categoryBySlug, CATEGORIES } from "./categories.js";
import { validateAgentCard, CARD_SCHEME, CARD_VERSION, bindingCheckHints } from "./agentCard.js";
import { MAX_LOG_SPAN, ERC8004, identityAbi, validationAbi } from "./erc8004.js";
import { openStore, type AgentRow } from "./store.js";
import { loadIdentities, type Identity } from "./registerIdentity.js";
import { rescoreAgent } from "./rescore.js";
import { verifyMerkleProof, x402ReceiptHash, type X402Receipt } from "./x402.js";
import { recoverReceiptSigner as recoverX402Signer } from "./x402Client.js";

const PORT = Number(process.env.NODE_PORT ?? 8790);
const STATE_DIR = process.env.OCULOPUS_STATE_DIR ?? "data";
const STATE_PATH = `${STATE_DIR}/state.json`;
const POLL_MS = 4000;
// The RPC rejects wider eth_getLogs spans ("Maximum allowed number of requested
// blocks is 1000", -32005) — confirmed live against a real range request.
const CHUNK = MAX_LOG_SPAN;
// How far back to hunt for a batch anchor when a receipt is published. 20 chunks is a
// few hours of Arc blocks — comfortably longer than the gap between a provider
// anchoring and a buyer getting round to counter-signing.
const X402_ANCHOR_LOOKBACK_CHUNKS = 20n;
// Persist progress mid-catch-up every N chunks, so a long first backfill (millions of
// blocks from the genesis scan point) resumes on restart instead of rescanning.
const SAVE_EVERY_CHUNKS = 50;
// How far back to hunt for a provider's ERC-8004 registration when auto-listing it
// from a verified receipt. The Registered event's owner is indexed, so this is a
// cheap filtered scan; agents registered longer ago than this still list and score,
// just without an agentId (so no ERC-8004 raw column).
const DISCOVERY_LOOKBACK_CHUNKS = 30n;

// Node role. The same binary scales from one all-in-one node (demo) to a fleet by
// config alone: an `indexer` stays light — syncs head, validates receipts, lists
// agents — so it holds head on shared RPC; a `worker` carries the heavy full-network
// ERC-8183 job scan + scoring; a `reference` node does both. Jobs are the one rail
// heavy enough to fall behind head, so it is the one an indexer drops. (Named `indexer`
// not `validator` to avoid confusion with Arc's consensus validators.) See
// docs/NODE-VPS.md.
const ROLE = (process.env.OCULOPUS_ROLE ?? "reference").toLowerCase();
if (!["reference", "indexer", "worker"].includes(ROLE)) {
  console.warn(`[role] unknown OCULOPUS_ROLE "${ROLE}" — treating it as "reference"`);
}
const INDEXES_JOBS = ROLE !== "indexer";

// A light indexer can offload scoring to a heavier worker: set OCULOPUS_SCORER_URL to a
// node serving /scores (a worker/reference running the full-history job scan) and merge
// those richer scores into this node's directory. Empty = score locally.
const SCORER_URL = (process.env.OCULOPUS_SCORER_URL ?? "").replace(/\/$/, "");
let scorerProviders = new Map<string, ScoreBreakdown>();
async function fetchScorer(): Promise<void> {
  if (!SCORER_URL) return;
  try {
    const r = await fetch(`${SCORER_URL}/scores`);
    if (!r.ok) return;
    const d = (await r.json()) as { providers?: Record<string, ScoreBreakdown> };
    scorerProviders = new Map(Object.entries(d.providers ?? {}));
  } catch { /* keep the last good scores if the worker is briefly unreachable */ }
}


// Known gateway witness addresses (tier X). Comma-separated env; empty = none yet.
const WITNESSES = new Set(
  (process.env.WITNESS_ADDRESSES ?? "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean),
);

interface StoredReceipt {
  signed: SignedReceipt;
  receivedAt: number;
  verified?: { block: number; tx: Hex; witnessed: boolean; memoIndex: number; providerSigned: boolean };
}
interface Erc8004Summary {
  clients: number;
  feedback: number;
  /** Plain mean of published ratings — what a naive ERC-8004 reader would show. */
  rawScore: number;
}
interface AgentListing {
  agentId?: string; // ERC-8004 agentId
  erc8004?: Erc8004Summary;
  /** ERC-8004 ValidationRegistry: independent re-execution attestations. */
  validations?: { count: number; average: number };
  serviceTag: number;
  metadataURI: string;
  registeredAt: number;
}
/** A settled ERC-8183 job, indexed as tier-1 evidence. Keyed by jobId. */
interface StoredJob {
  provider: string;
  client: string;
  evaluator: string;
  /** Escrowed amount from JobFunded; undefined if it fell outside the search window. */
  usdc?: string;
  outcome: "success" | "fail";
  independentEvaluator: boolean;
  settledAt: number; // unix ms, from the block
  tx: Hex;
}
/**
 * An x402 receipt awaiting, or holding, an on-chain anchor.
 *
 * Unlike the on-chain rail there is no payment transaction to inspect, so the buyer's
 * counter-signature carries the whole payment claim. A receipt without one is stored
 * but never scored: a provider alone could otherwise mint receipts naming any buyer.
 */
interface StoredX402 {
  receipt: X402Receipt;
  hash: Hex;
  providerSig: Hex;
  buyerSig?: Hex;
  /** Merkle root the provider anchors, and this receipt's path into it. */
  root: Hex;
  proof: Hex[];
  receivedAt: number;
  /** Set once the root is seen in a Memo event on Arc. */
  verified?: { tx: Hex; block: number };
}
interface State {
  lastBlock: number;
  /** jobId -> escrowed USDC, captured from JobFunded. See indexJobs. */
  jobFunding?: Record<string, string>;
  receipts: Record<string, StoredReceipt>; // keyed by memoId (= receiptHash)
  jobs: Record<string, StoredJob>; // keyed by ERC-8183 jobId
  x402?: Record<string, StoredX402>; // keyed by receipt hash
  agents: Record<string, AgentListing>; // keyed by lowercase address
  /** owner (lowercase) -> ERC-8004 identity, indexed from Registered events as we scan. */
  agentIds?: Record<string, { agentId: string; agentURI: string }>;
}

// Where a fresh node starts indexing. Replaying everything is right for a real
// directory but wrong for a throwaway run: the chain moves ~200k blocks a day and
// catching up at 1000 blocks per request takes longer than the run. Set
// OCULOPUS_START_BLOCK to begin near the head instead. See docs/NODE-VPS.md.
const startBlock = process.env.OCULOPUS_START_BLOCK
  ? Number(process.env.OCULOPUS_START_BLOCK)
  : GENESIS_SCAN_BLOCK;
const state: State = existsSync(STATE_PATH)
  ? (JSON.parse(readFileSync(STATE_PATH, "utf8")) as State)
  : { lastBlock: startBlock - 1, receipts: {}, jobs: {}, x402: {}, agents: {}, agentIds: {} };

// OCULOPUS_START_BLOCK is also a floor on an EXISTING index: raise it above where we
// have scanned to fast-forward a slow backfill to recent activity (e.g. jump millions
// of genesis blocks straight to where fresh receipts are). Forward only — a value at
// or below lastBlock is ignored, so this never rewinds or triggers a rescan.
if (process.env.OCULOPUS_START_BLOCK && startBlock - 1 > state.lastBlock) {
  console.log(`[indexer] fast-forward lastBlock ${state.lastBlock} → ${startBlock - 1} (OCULOPUS_START_BLOCK)`);
  state.lastBlock = startBlock - 1;
}

state.jobs ??= {}; // state files written before job indexing existed
state.x402 ??= {};
state.jobFunding ??= {};
state.agentIds ??= {}; // state files written before registration indexing existed

// SQLite store — the queryable, product-grade data layer. Written alongside state.json
// (dual-write) so the JSON path keeps working while the store fills; reads migrate next.
const DB_PATH = process.env.OCULOPUS_DB ?? `${STATE_DIR}/oculopus.db`;
const store = openStore(DB_PATH);
// Backfill the store from any pre-existing state.json, so a node that indexed before the
// store existed serves its FULL history from the store — not just what dual-write has
// added since. Idempotent upserts; the store is complete before anything serves.
syncStateToStore();

function saveState(): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  store.setNumber("lastBlock", state.lastBlock);
}

function syncStateToStore(): void {
  for (const [owner, id] of Object.entries(state.agentIds ?? {})) store.putAgentId(owner, id.agentId, id.agentURI, null);
  for (const [address, a] of Object.entries(state.agents)) store.putAgent({ address, ...a });
  for (const [jobId, j] of Object.entries(state.jobs)) store.putJob({ jobId, ...j });
  for (const [hash, s] of Object.entries(state.receipts)) {
    if (!s.verified) continue;
    const r = s.signed.receipt;
    store.putReceipt({
      hash, buyer: r.who.buyer, provider: r.who.provider, service: r.what.service,
      usdc: r.howMuch.usdc, outcome: r.effect.outcome, deliveredAt: r.when.deliveredAt,
      receivedAt: s.receivedAt, verified: true, block: s.verified.block, tx: s.verified.tx,
      witnessed: s.verified.witnessed, providerSigned: s.verified.providerSigned,
      latency: r.effect.latencyMs, disputed: r.risk.dispute, requestedAt: r.when.requestedAt,
      docJson: JSON.stringify(s.signed),
    });
  }
  store.setNumber("lastBlock", state.lastBlock);
}

const pub = createPublicClient({
  chain: arcTestnet,
  transport: fallback(RPC_URLS.map((u) => http(u, { retryCount: 4, retryDelay: 1500 }))),
});

// ---------------------------------------------------------------- identity ------
// Agent identity comes from Arc's ERC-8004 IdentityRegistry, not from a registry of
// our own. data/identities.json only says WHICH agentIds to serve; every claim in it
// is re-checked against the chain here, so a doctored file cannot list an agent whose
// wallet does not actually own that agentId.
async function loadDirectoryFromErc8004(): Promise<void> {
  // Two sources, both ending at the same on-chain check below:
  //   OCULOPUS_AGENT_IDS  — a bare list of agentIds; everything else is read from
  //     the registry. This is what a fresh clone on a server uses, since data/ is
  //     gitignored and holds no secrets a node operator needs.
  //   data/identities.json — written locally by `npm run register:identity`.
  const fromEnv: Identity[] = [];
  for (const raw of (process.env.OCULOPUS_AGENT_IDS ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    try {
      const agentId = BigInt(raw);
      const [owner, uri] = [
        await pub.readContract({ address: ERC8004.identity, abi: identityAbi, functionName: "ownerOf", args: [agentId] }),
        await pub.readContract({ address: ERC8004.identity, abi: identityAbi, functionName: "tokenURI", args: [agentId] }),
      ];
      // agentURI often points at the agent card; the callable base is its parent.
      const endpoint = uri.replace(/\/agent-card\.json$/, "");
      fromEnv.push({ address: owner, agentId: raw, agentURI: uri, endpoint, serviceTag: 1 });
    } catch (e) {
      console.error(`[identity] agentId ${raw}: ${(e as Error).message}`);
    }
  }

  const seen = new Set(fromEnv.map((i) => i.address.toLowerCase()));
  for (const id of [...fromEnv, ...loadIdentities().filter((i) => !seen.has(i.address.toLowerCase()))]) {
    if (id.serviceTag === 0) continue; // buyer-only identity, not a listed service
    const owner = await pub.readContract({
      address: ERC8004.identity,
      abi: identityAbi,
      functionName: "ownerOf",
      args: [BigInt(id.agentId)],
    });
    if (owner.toLowerCase() !== id.address.toLowerCase()) {
      console.warn(`[identity] SKIP ${id.address} — agentId ${id.agentId} is owned by ${owner}`);
      continue;
    }
    state.agents[id.address.toLowerCase()] = {
      agentId: id.agentId,
      serviceTag: id.serviceTag,
      metadataURI: id.endpoint,
      registeredAt: Date.now(),
    };
    store.putAgent({ address: id.address.toLowerCase(), ...state.agents[id.address.toLowerCase()]! });
  }
  console.log(`[identity] ${Object.keys(state.agents).length} agent(s) verified against ERC-8004`);
}

// ------------------------------------------------------------------- indexer -----
let scanning = false;

async function scan(): Promise<void> {
  if (scanning) return;
  scanning = true;
  try {
    const latest = await pub.getBlockNumber();
    let from = BigInt(state.lastBlock + 1);
    let chunksSinceSave = 0;
    while (from <= latest) {
      const to = from + CHUNK - 1n > latest ? latest : from + CHUNK - 1n;

      // ERC-8004 identities: index every Registration into an owner->agentId map, so an
      // agentId resolves for ANY agent whose registration we have scanned — completely,
      // regardless of how long ago it registered, and with no per-agent lookback (which
      // missed old agents and, in bulk, is what stalled discovery). Indexed before
      // receipts so a same-chunk registration is already resolvable when its receipt
      // verifies.
      for (const reg of await pub.getLogs({ address: ERC8004.identity, event: identityAbi[7], fromBlock: from, toBlock: to })) {
        const owner = (reg.args.owner as string).toLowerCase();
        const identity = { agentId: String(reg.args.agentId), agentURI: reg.args.agentURI as string };
        state.agentIds![owner] = identity;
        store.putAgentId(owner, identity.agentId, identity.agentURI, Number(reg.blockNumber));
      }

      // Memo receipts
      const memoLogs = await pub.getLogs({ address: CONTRACTS.memo, event: memoAbi[2], fromBlock: from, toBlock: to });
      for (const log of parseEventLogs({ abi: memoAbi, eventName: "Memo", logs: memoLogs })) {
        if (!decodeMemoData(log.args.memo as Hex)) continue; // not an OCU1 receipt
        const memoId = log.args.memoId as Hex;
        // A memoId is either a single receipt's hash (on-chain rail) or a Merkle root
        // over a batch of x402 receipts. Try the batch first: it is a cheap map lookup
        // and the two namespaces cannot collide, since a root is only ever recorded
        // here after a provider POSTed receipts that hash into it.
        markX402Anchored(memoId, log.transactionHash, Number(log.blockNumber));
        await verifyOnChainReceipt(memoId, log.args.sender as Hex, log.transactionHash, Number(log.blockNumber), Number(log.args.memoIndex));
      }

      if (INDEXES_JOBS) await indexJobs(from, to);

      from = to + 1n;
      state.lastBlock = Number(to);
      if (++chunksSinceSave >= SAVE_EVERY_CHUNKS) { saveState(); chunksSinceSave = 0; }
    }
    saveState();
  } catch (e) {
    console.error(`[indexer] ${(e as Error).message}`);
  } finally {
    scanning = false;
  }
}

// Block timestamps, cached — decay needs real times, not index time, and refetching
// the same block per log would triple the RPC traffic.
const blockTimes = new Map<string, number>();
async function blockTimeMs(blockNumber: bigint): Promise<number> {
  const key = String(blockNumber);
  const hit = blockTimes.get(key);
  if (hit) return hit;
  const b = await pub.getBlock({ blockNumber });
  const ms = Number(b.timestamp) * 1000;
  blockTimes.set(key, ms);
  return ms;
}

/** Search back a bounded window for the JobFunded event of a job settled outside it. */
async function findFundingAmount(jobId: bigint, settledAt: bigint): Promise<string | undefined> {
  for (let i = 0n; i < 10n; i++) {
    const to = settledAt - i * MAX_LOG_SPAN;
    const from = to > MAX_LOG_SPAN ? to - MAX_LOG_SPAN + 1n : 0n;
    const logs = await pub.getLogs({ address: ERC8183.job, event: jobAbi[1], args: { jobId }, fromBlock: from, toBlock: to });
    if (logs[0]) return formatUnits(logs[0].args.amount!, 6);
    if (from === 0n) break;
  }
  return undefined;
}

/**
 * Index settled ERC-8183 jobs as tier-1 evidence.
 *
 * Nothing here needs our receipt store: escrow, agreement and the evaluator's verdict
 * are all chain state. That makes a settled job the one kind of evidence a fresh node
 * can reconstruct from the chain alone.
 */
async function indexJobs(from: bigint, to: bigint): Promise<void> {
  // Capture escrow amounts as they are funded. getJob() cannot be used for this: once
  // the job completes, payment is released and `budget` reads back as 0, which would
  // silently record every settled job as a $0 job.
  for (const f of await pub.getLogs({ address: ERC8183.job, event: jobAbi[1], fromBlock: from, toBlock: to })) {
    state.jobFunding![String(f.args.jobId)] = formatUnits(f.args.amount!, 6);
  }

  const settled = [
    ...(await pub.getLogs({ address: ERC8183.job, event: jobAbi[2], fromBlock: from, toBlock: to })), // JobCompleted
    ...(await pub.getLogs({ address: ERC8183.job, event: jobAbi[3], fromBlock: from, toBlock: to })), // JobRejected
  ];
  for (const log of settled) {
    const jobId = String(log.args.jobId);
    if (state.jobs[jobId]) continue;
    try {
      const { client, provider, evaluator, budget } = await pub.readContract({
        address: ERC8183.job,
        abi: jobAbi,
        functionName: "getJob",
        args: [log.args.jobId!],
      });
      const outcome = log.eventName === "JobCompleted" ? "success" : "fail";
      // Funded in an earlier chunk than the one we are scanning? Look back a bounded
      // window. Still missing => leave the amount UNSET rather than claim $0; an
      // unknown amount weighs neutrally, a zero one would not.
      let usdc = state.jobFunding![jobId];
      if (usdc === undefined) usdc = await findFundingAmount(log.args.jobId!, log.blockNumber!);
      state.jobs[jobId] = {
        provider: provider.toLowerCase(),
        client: client.toLowerCase(),
        evaluator: evaluator.toLowerCase(),
        usdc,
        outcome,
        independentEvaluator: hasIndependentEvaluator({ client, evaluator }),
        settledAt: await blockTimeMs(log.blockNumber!),
        tx: log.transactionHash!,
      };
      store.putJob({ jobId, ...state.jobs[jobId]! });
      console.log(`[jobs] ERC-8183 #${jobId} ${outcome} ${client.slice(0, 8)}→${provider.slice(0, 8)} ${usdc ? "$" + usdc : "amount unknown"}${hasIndependentEvaluator({ client, evaluator }) ? " [independent evaluator]" : ""}`);
    } catch (e) {
      console.error(`[jobs] #${jobId}: ${(e as Error).message}`);
    }
  }
}

// The full protocol verification chain for one on-chain receipt.
async function verifyOnChainReceipt(memoId: Hex, sender: Hex, tx: Hex, block: number, memoIndex: number): Promise<void> {
  const stored = state.receipts[memoId];
  if (!stored || stored.verified) return;
  const r = stored.signed.receipt;

  const v = await verifySignedReceipt(stored.signed);
  if (v.hash !== memoId) return log_reject(memoId, "hash mismatch");
  if (!v.buyerSigned) return log_reject(memoId, "buyer signature invalid");
  // Provider sig is required for positive receipts. A FAIL receipt may be unilateral
  // (a failing provider won't countersign its own failure) — it still costs the buyer
  // a real on-chain payment to record, which is what keeps defamation expensive.
  if (r.effect.outcome !== "fail" && !v.providerSigned) return log_reject(memoId, "provider signature missing on non-fail receipt");
  if (sender.toLowerCase() !== r.who.buyer.toLowerCase()) return log_reject(memoId, "tx sender is not the receipt buyer");

  // The payment must match the receipt: decode the memo-wrapped USDC transfer.
  const txData = await pub.getTransaction({ hash: tx });
  const paysProvider = memoPaysProvider(txData.input, memoId, r.who.provider, r.howMuch.usdc);
  if (!paysProvider) return log_reject(memoId, "payment does not match receipt (to/amount)");

  const witnessed = !!v.witness && WITNESSES.has(v.witness.toLowerCase());
  // providerSigned is recorded even though check 3 waives it for failures: a buyer
  // that keeps filing UNILATERAL failures is the defamation signal on the buyer side.
  stored.verified = { block, tx, witnessed, memoIndex, providerSigned: v.providerSigned };
  store.putReceipt({
    hash: memoId, buyer: r.who.buyer, provider: r.who.provider, service: r.what.service,
    usdc: r.howMuch.usdc, outcome: r.effect.outcome, deliveredAt: r.when.deliveredAt,
    receivedAt: stored.receivedAt, verified: true, block, tx, witnessed, providerSigned: v.providerSigned,
    latency: r.effect.latencyMs, disputed: r.risk.dispute, requestedAt: r.when.requestedAt,
    docJson: JSON.stringify(stored.signed),
  });
  console.log(`[indexer] verified receipt ${memoId.slice(0, 10)}… ${r.who.buyer.slice(0, 8)}→${r.who.provider.slice(0, 8)} ${r.effect.outcome} $${r.howMuch.usdc}${witnessed ? " [witnessed]" : ""}`);
  await ensureAgentListed(r.who.provider, r.what.service, r.where.endpoint);
}

// Auto-list a provider the moment one of its receipts verifies — the directory is
// permissionless, so presence is EARNED by a real anchored receipt, not granted by an
// allowlist. OCULOPUS_AGENT_IDS still works and takes precedence; this only fills in
// agents nobody configured. Spam is handled where it should be — by the score, which
// starts fresh agents low and caps what any single counterparty can vouch for.
async function ensureAgentListed(provider: string, serviceSlug: string, endpoint: string): Promise<void> {
  const addr = provider.toLowerCase();
  if (state.agents[addr]) return; // already configured or discovered — never overwrite
  const resolved = await findAgentId(provider as Hex);
  const uri = resolved ? resolved.agentURI.replace(/\/agent-card\.json$/, "") : endpoint;
  state.agents[addr] = {
    agentId: resolved?.agentId,
    serviceTag: categoryBySlug(serviceSlug)?.tag ?? 9,
    metadataURI: uri,
    registeredAt: Date.now(),
  };
  store.putAgent({ address: addr, ...state.agents[addr]! });
  console.log(`[discover] listed ${addr} ${resolved ? `agentId ${resolved.agentId}` : "(no agentId in window)"} — ${serviceSlug}`);
}

// Resolve an address's agentId from the IdentityRegistry. Registered carries an
// INDEXED owner, so this is a filtered getLogs — but the RPC caps each request at
// 1000 blocks, so a bounded lookback from the head rather than a full-history scan.
async function findAgentId(owner: Hex): Promise<{ agentId: string; agentURI: string } | null> {
  const key = owner.toLowerCase();
  // Fast path: the scan indexes every Registration into state.agentIds, so any agent
  // whose registration we have already scanned resolves with no RPC at all.
  if (state.agentIds![key]) return state.agentIds![key]!;
  // Fallback: a registration the main scan has not reached yet (e.g. a fast-forwarded
  // node that jumped past it). Bounded lookback from head; cache whatever it finds.
  const head = await pub.getBlockNumber();
  for (let i = 0n; i < DISCOVERY_LOOKBACK_CHUNKS; i++) {
    const to = head - i * CHUNK;
    if (to <= 0n) break;
    const from = to > CHUNK ? to - CHUNK + 1n : 0n;
    const logs = await pub.getLogs({ address: ERC8004.identity, event: identityAbi[7], args: { owner }, fromBlock: from, toBlock: to });
    const log = logs[logs.length - 1]; // most recent registration by this owner
    if (log) {
      const r = { agentId: String(log.args.agentId), agentURI: log.args.agentURI as string };
      state.agentIds![key] = r;
      return r;
    }
    if (from === 0n) break;
  }
  return null;
}

// Retro-discovery. verifyOnChainReceipt only auto-lists a provider the FIRST time a
// receipt verifies — receipts already marked verified by an earlier build (before
// auto-listing existed) never re-trigger it, and their blocks are already scanned. So
// on startup, sweep everything already on disk and list any provider still missing.
async function discoverFromVerified(): Promise<void> {
  const before = Object.keys(state.agents).length;
  for (const s of Object.values(state.receipts)) {
    if (!s.verified) continue;
    const r = s.signed.receipt;
    await ensureAgentListed(r.who.provider, r.what.service, r.where.endpoint);
  }
  const added = Object.keys(state.agents).length - before;
  if (added) { saveState(); console.log(`[discover] back-filled ${added} agent(s) from verified receipts on disk`); }
}

/**
 * Does this transaction's calldata contain a Memo call for `memoId` that pays
 * `provider` exactly `usdc`?
 *
 * The memo may sit at the top level, or nested inside a Multicall3From.aggregate3
 * when the buyer settled payment and ERC-8004 feedback atomically. Both are valid
 * on-chain; an indexer that only understood the flat shape rejected every batched
 * receipt as "payment does not match". Any independent implementation has to unwrap
 * the same two shapes — see docs/RECEIPT-SPEC.md.
 */
function memoPaysProvider(input: Hex, memoId: Hex, provider: string, usdc: string): boolean {
  const callDatas: Hex[] = [input];
  try {
    const outer = decodeFunctionData({ abi: multicall3FromAbi, data: input });
    if (outer.functionName === "aggregate3") {
      const [calls] = outer.args as [readonly { target: Hex; allowFailure: boolean; callData: Hex }[]];
      callDatas.push(...calls.map((c) => c.callData));
    }
  } catch {
    /* not a multicall — the flat shape below still applies */
  }

  for (const data of callDatas) {
    try {
      const outer = decodeFunctionData({ abi: memoAbi, data });
      if (outer.functionName !== "memo") continue;
      const [target, inner, id] = outer.args as [Hex, Hex, Hex, Hex];
      if (id.toLowerCase() !== memoId.toLowerCase()) continue; // a different receipt in the same batch
      if (target.toLowerCase() !== CONTRACTS.usdc.toLowerCase()) continue;
      const call = decodeFunctionData({ abi: erc20Abi, data: inner });
      if (call.functionName !== "transfer") continue;
      const [to, amount] = call.args as [Hex, bigint];
      if (to.toLowerCase() === provider.toLowerCase() && amount === parseUnits(usdc, 6)) return true;
    } catch {
      /* undecodable entry → skip it */
    }
  }
  return false;
}

function log_reject(memoId: Hex, why: string): void {
  console.log(`[indexer] REJECT ${memoId.slice(0, 10)}… — ${why}`);
}

// Raw ERC-8004 reputation, alongside our verified score. Published feedback is
// unbound — anyone can write it, the rated agent never signs, no payment is
// implied — so the two numbers answer different questions and the dashboard shows
// both rather than silently preferring ours.
async function refreshErc8004(): Promise<void> {
  for (const [addr, listing] of Object.entries(state.agents)) {
    if (!listing.agentId) continue;
    try {
      state.agents[addr]!.validations = await readValidations(BigInt(listing.agentId));
      const summary = await rescoreAgent(BigInt(listing.agentId));
      state.agents[addr]!.erc8004 = {
        clients: summary.clients,
        feedback: summary.feedback + summary.unreadEntries,
        rawScore: summary.rawScore,
      };
      store.putAgent({ address: addr, ...state.agents[addr]! });
    } catch (e) {
      console.error(`[erc8004] ${listing.agentId}: ${(e as Error).message}`);
    }
  }
}

/**
 * ERC-8004's third registry: independent validators re-execute a job and attest.
 *
 * This is the only mechanism that reaches QUALITY. Everything else in Oculopus proves
 * a job was paid for and both sides described it the same way — never that the work
 * was any good. Reported as its own figure rather than folded into the score, because
 * on Arc today no validator has attested to anything and a fabricated signal would be
 * worse than an empty one.
 */
async function readValidations(agentId: bigint): Promise<{ count: number; average: number } | undefined> {
  try {
    const hashes = await pub.readContract({
      address: ERC8004.validation,
      abi: validationAbi,
      functionName: "getAgentValidations",
      args: [agentId],
    });
    if (!hashes.length) return { count: 0, average: 0 };
    const validators = new Set<string>();
    for (const h of hashes.slice(0, 50)) {
      const [validator] = await pub.readContract({
        address: ERC8004.validation,
        abi: validationAbi,
        functionName: "getValidationStatus",
        args: [h],
      });
      validators.add(validator);
    }
    const [count, average] = await pub.readContract({
      address: ERC8004.validation,
      abi: validationAbi,
      functionName: "getSummary",
      args: [agentId, [...validators] as `0x${string}`[], ""],
    });
    return { count: Number(count), average: Number(average) };
  } catch {
    return undefined; // registry unreachable or agent unknown — report nothing, invent nothing
  }
}

// ------------------------------------------------------------------ scoring ------
function verifiedRecords(): ReceiptRecord[] {
  // Read from the store. usdc/witnessed/providerSigned were all proven at verify time;
  // `disputed` lives only in the co-signed document, so it comes from the stored doc.
  return store.verifiedReceipts().map((row) => ({
    provider: row.provider,
    buyer: row.buyer,
    outcome: row.outcome as ReceiptRecord["outcome"],
    disputed: !!(JSON.parse(row.doc_json).receipt?.risk?.dispute),
    witnessed: !!row.witnessed,
    deliveredAt: row.delivered_at,
    usdc: row.usdc,
    providerCountersigned: !!row.provider_signed,
    tier: "receipt" as const,
  }));
}

/**
 * Mark every stored x402 receipt whose batch root just appeared on chain.
 *
 * The proof was checked when the receipt was accepted; this only records that the
 * provider actually paid to commit the batch. Until that happens a provider could
 * hand out receipts it never anchored, so unanchored ones do not score.
 */
async function findAnchor(root: Hex): Promise<{ tx: Hex; block: number } | null> {
  // The forward scan alone is not enough. A provider anchors as soon as its batch is
  // full, but the receipt only reaches this node once the BUYER has counter-signed —
  // always later, often after the indexer has already passed that block. Measured: an
  // anchor at block 52945592 was long behind lastBlock by the time the receipts
  // arrived, so nothing was ever marked. So on ingest, look back for the root too.
  const head = await pub.getBlockNumber();
  for (let i = 0n; i < X402_ANCHOR_LOOKBACK_CHUNKS; i++) {
    const to = head - i * CHUNK;
    if (to <= 0n) break;
    const from = to > CHUNK ? to - CHUNK + 1n : 0n;
    const logs = await pub.getLogs({ address: CONTRACTS.memo, event: memoAbi[2], args: { memoId: root }, fromBlock: from, toBlock: to });
    const log = logs[0];
    if (log) return { tx: log.transactionHash, block: Number(log.blockNumber) };
    if (from === 0n) break;
  }
  return null;
}

function markX402Anchored(root: Hex, tx: Hex, block: number): void {
  let n = 0;
  for (const entry of Object.values(state.x402!)) {
    if (entry.verified || entry.root.toLowerCase() !== root.toLowerCase()) continue;
    entry.verified = { tx, block };
    n += 1;
  }
  if (n) console.log(`[x402] anchored ${n} receipt(s) — root ${root.slice(0, 10)}… tx ${tx.slice(0, 10)}…`);
}

/**
 * x402 receipts that are anchored AND counter-signed by the buyer.
 *
 * Both conditions are load-bearing. Without the anchor a provider can claim anything;
 * without the buyer's signature the provider is the only party asserting a payment
 * that never appears on chain.
 */
function x402Records(): ReceiptRecord[] {
  return Object.values(state.x402!)
    .filter((e) => e.verified && e.buyerSig)
    .map((e) => ({
      provider: e.receipt.who.provider.toLowerCase(),
      buyer: e.receipt.who.buyer.toLowerCase(),
      outcome: e.receipt.effect.outcome,
      disputed: e.receipt.risk.dispute,
      witnessed: false,
      deliveredAt: e.receipt.when.deliveredAt,
      usdc: e.receipt.howMuch.usdc,
      providerCountersigned: true, // the provider signed it before serving it
      tier: "receipt-x402" as const,
    }));
}

/** Settled ERC-8183 jobs, as tier-1 records alongside our own receipts. */
function jobRecords(): ReceiptRecord[] {
  return store.allJobs().map((j) => ({
    provider: j.provider,
    buyer: j.client,
    outcome: j.outcome as ReceiptRecord["outcome"],
    disputed: false,
    witnessed: false,
    deliveredAt: j.settled_at,
    usdc: j.usdc ?? undefined,
    // The evaluator judged it, so a failure here is never a one-sided buyer claim.
    providerCountersigned: true,
    tier: j.independent_evaluator ? ("job-evaluated" as const) : ("job-self" as const),
  }));
}

function allRecords(): ReceiptRecord[] {
  return [...verifiedRecords(), ...jobRecords(), ...x402Records()];
}

/**
 * Buyers ranked by how safe they are to accept work from. Buyers are not listed in
 * the ERC-8004 directory — they are discovered purely from the receipts they paid
 * for, which is the point: you cannot register your way into a buyer reputation,
 * you can only transact your way into one.
 */
function buyerDirectory(): (ScoreBreakdown & { address: string })[] {
  const { buyers } = propagate(allRecords());
  return [...buyers]
    .map(([address, s]) => ({ address, ...s }))
    .sort((x, y) => y.score - x.score);
}

interface DirectoryEntry extends AgentListing, ScoreBreakdown {
  address: string;
  category: string;
  categoryLabel: string;
  /** Where this agent's evidence came from — the dashboard shows the mix. */
  rails: { onchain: number; x402: number; job: number };
}

/** An AgentRow (store) → the in-memory AgentListing shape the directory/API expect. */
function agentRowToListing(a: AgentRow): AgentListing {
  return {
    agentId: a.agent_id ?? undefined,
    serviceTag: a.service_tag,
    metadataURI: a.metadata_uri,
    registeredAt: a.registered_at,
    erc8004: a.erc8004_json ? JSON.parse(a.erc8004_json) : undefined,
    validations: a.validations_json ? JSON.parse(a.validations_json) : undefined,
  };
}

function directory(serviceTag?: number): DirectoryEntry[] {
  // Propagated: a counterparty's praise is worth what that counterparty is worth, so
  // a cluster of fresh wallets lifts nobody. Complaints are never discounted.
  const records = allRecords();
  const { providers } = propagate(records);
  return store.allAgents()
    .map((row) => [row.address, agentRowToListing(row)] as const)
    .filter(([, a]) => serviceTag === undefined || a.serviceTag === serviceTag)
    .map(([address, a]) => {
      const mine = records.filter((r) => r.provider === address);
      return {
        address,
        ...a,
        category: categorySlug(a.serviceTag),
        categoryLabel: categoryLabel(a.serviceTag),
        rails: {
          onchain: mine.filter((r) => (r.tier ?? "receipt") === "receipt").length,
          x402: mine.filter((r) => r.tier === "receipt-x402").length,
          job: mine.filter((r) => r.tier === "job-evaluated" || r.tier === "job-self").length,
        },
        ...(scorerProviders.get(address) ?? providers.get(address) ?? scoreProvider([])),
      };
    })
    .sort((x, y) => y.score - x.score);
}

// --------------------------------------------------------------------- HTTP ------
// The node serves the same static multi-page site Vercel hosts (site/), so
// localhost:8790 is the full product with live same-origin data. Clean URLs:
// /dashboard → dashboard.html, / → index.html.
const SITE_DIR = new URL("../site/", import.meta.url);
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
};

function serveStatic(pathname: string, res: ServerResponse): boolean {
  let p = decodeURIComponent(pathname);
  if (p.includes("..")) return false;
  if (p === "/") p = "/index.html";
  if (!extname(p)) p += ".html";
  const file = new URL("." + p, SITE_DIR);
  if (!existsSync(file)) return false;
  res.writeHead(200, { "Content-Type": MIME[extname(p)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
  return true;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || "{}");
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "POST" && url.pathname === "/receipts") {
      const signed = (await readBody(req)) as SignedReceipt;
      const v = await verifySignedReceipt(signed);
      if (!v.buyerSigned && !v.providerSigned) return json(res, 400, { error: "no valid signature" });
      const hash = receiptHash(signed.receipt);
      if (!state.receipts[hash]) state.receipts[hash] = { signed, receivedAt: Date.now() };
      saveState();
      return json(res, 200, { hash, stored: true });
    }
    if (req.method === "POST" && url.pathname === "/x402/receipts") {
      // Everything checkable off-chain is checked here; the anchor is confirmed later
      // by the indexer. A caller cannot talk its way past any of it.
      const body = (await readBody(req)) as {
        receipt?: X402Receipt; providerSig?: Hex; buyerSig?: Hex; root?: Hex; proof?: Hex[];
      };
      const { receipt, providerSig, buyerSig, root, proof } = body;
      if (!receipt || !providerSig || !root || !Array.isArray(proof)) {
        return json(res, 400, { error: "need receipt, providerSig, root and proof" });
      }
      const hash = x402ReceiptHash(receipt);
      if (!verifyMerkleProof(hash, proof, root)) {
        return json(res, 400, { error: "receipt is not in that Merkle root" });
      }
      if ((await recoverX402Signer(hash, providerSig)).toLowerCase() !== receipt.who.provider.toLowerCase()) {
        return json(res, 400, { error: "providerSig does not recover to receipt.who.provider" });
      }
      // The buyer signature is optional to STORE and required to SCORE — a provider is
      // allowed to publish its side early, it just earns nothing until the buyer agrees.
      if (buyerSig && (await recoverX402Signer(hash, buyerSig)).toLowerCase() !== receipt.who.buyer.toLowerCase()) {
        return json(res, 400, { error: "buyerSig does not recover to receipt.who.buyer" });
      }
      const existing = state.x402![hash];
      const entry: StoredX402 = existing
        ? { ...existing, buyerSig: buyerSig ?? existing.buyerSig } // let a buyer add its signature later
        : { receipt, hash, providerSig, buyerSig, root, proof, receivedAt: Date.now() };
      // The batch was almost certainly anchored before this receipt was published, so
      // look back rather than waiting for a forward scan that already went past it.
      if (!entry.verified) entry.verified = (await findAnchor(root)) ?? undefined;
      state.x402![hash] = entry;
      saveState();
      return json(res, 200, { hash, stored: true, counterSigned: !!state.x402![hash]!.buyerSig, anchored: !!state.x402![hash]!.verified });
    }
    if (req.method === "GET" && url.pathname === "/x402/receipts") {
      return json(res, 200, {
        total: Object.keys(state.x402!).length,
        scored: x402Records().length,
        receipts: Object.values(state.x402!).map((e) => ({
          hash: e.hash, buyer: e.receipt.who.buyer, provider: e.receipt.who.provider,
          usdc: e.receipt.howMuch.usdc, counterSigned: !!e.buyerSig,
          anchored: !!e.verified, tx: e.verified?.tx,
        })),
      });
    }
    if (req.method === "GET" && url.pathname.startsWith("/receipts/")) {
      const hash = url.pathname.split("/")[2] ?? "";
      const stored = state.receipts[hash];
      return stored ? json(res, 200, stored) : json(res, 404, { error: "not found" });
    }
    if (req.method === "GET" && url.pathname === "/agent-card/scheme") {
      // Discoverable spec: an operator (or a register form) fetches this to learn the
      // shape and the valid categories, then POSTs a card to /agent-card/validate.
      return json(res, 200, {
        scheme: CARD_SCHEME, v: CARD_VERSION,
        categories: CATEGORIES.map((c) => ({ tag: c.tag, slug: c.slug, label: c.label })),
        onChainBinding: bindingCheckHints,
      });
    }
    if (req.method === "POST" && url.pathname === "/agent-card/validate") {
      // Shape check only — the node cannot prove ownership of a card it was merely
      // handed. It says so, and lists what still needs an on-chain check.
      const result = validateAgentCard(await readBody(req));
      return json(res, result.valid ? 200 : 400, { ...result, onChainBinding: bindingCheckHints });
    }
    if (req.method === "GET" && url.pathname === "/directory") {
      const tag = url.searchParams.get("serviceTag");
      return json(res, 200, { agents: directory(tag === null ? undefined : Number(tag)) });
    }
    if (req.method === "GET" && url.pathname === "/buyers") {
      return json(res, 200, { buyers: buyerDirectory() });
    }
    if (req.method === "GET" && url.pathname === "/scores") {
      const { providers, buyers } = propagate(allRecords());
      return json(res, 200, { providers: Object.fromEntries(providers), buyers: Object.fromEntries(buyers), generatedAt: Date.now() });
    }
    if (req.method === "GET" && url.pathname.startsWith("/agents/")) {
      const addr = (url.pathname.split("/")[2] ?? "").toLowerCase();
      const row = store.getAgent(addr);
      if (!row) return json(res, 404, { error: "not registered" });
      const listing = agentRowToListing(row);
      const records = allRecords().filter((r) => r.provider === addr);
      // Already verified + sorted (delivered_at DESC) by the store query.
      const receipts = store.receiptsByProvider(addr).map((s) => ({
        hash: s.hash,
        buyer: s.buyer,
        outcome: s.outcome,
        usdc: s.usdc,
        deliveredAt: s.delivered_at,
        tx: s.tx,
        witnessed: !!s.witnessed,
      }));
      // An address can be both: a provider that also buys from others. Report both
      // roles rather than pretending an agent only sits on one side of the market.
      const asBuyer = scoreBuyer(allRecords().filter((r) => r.buyer === addr));
      return json(res, 200, { address: addr, ...listing, ...(scorerProviders.get(addr) ?? scoreProvider(records)), asBuyer, recentReceipts: receipts.slice(0, 50) });
    }
    if (req.method === "GET" && serveStatic(url.pathname, res)) return;
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 400, { error: (e as Error).message });
  }
});

const chainId = await pub.getChainId();
if (chainId !== CHAIN_ID) throw new Error(`RPC chainId ${chainId} != ${CHAIN_ID}`);
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Oculopus node → http://localhost:${PORT}   (ERC-8004 identity ${ERC8004.identity}, scanning from block ${state.lastBlock + 1})`);
  console.log(`[role] ${ROLE}${INDEXES_JOBS ? "" : " — job indexing OFF (light indexer node)"}`);
});
// Pull worker scores independently of the (possibly throttled) identity/scan startup, so
// a light indexer shows merged scores promptly rather than after the first backfill.
if (SCORER_URL) { void fetchScorer(); setInterval(() => void fetchScorer(), 60_000); }
// Bind first so a throttled RPC at startup never delays serving. Identity, feedback
// and the first scan populate in the background as their calls resolve — the API is
// already up and answers requests while these awaits are pending.
await loadDirectoryFromErc8004();
await discoverFromVerified();
void refreshErc8004();
setInterval(() => void refreshErc8004(), 30_000);
void scan();
setInterval(() => void scan(), POLL_MS);
