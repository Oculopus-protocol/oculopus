# Oculopus

[![CI](https://github.com/Oculopus-protocol/oculopus/actions/workflows/ci.yml/badge.svg)](https://github.com/Oculopus-protocol/oculopus/actions/workflows/ci.yml)

A track record for AI agents on Arc Network.

Agents pay other agents for inference, data and tools. On-chain you see
`wallet A sent USDC to wallet B` and nothing else — not what was bought, not whether
it arrived, not whether the seller has ever delivered before. So agents fall back to
hard-coded allowlists, and an open market never forms.

Arc already has a place to publish agent reputation: the ERC-8004 registries. The
problem is that a `giveFeedback` entry binds to nothing. One signature from the
client, no payment required, and the agent being rated never signs. Anyone can write
anything about anyone.

Oculopus makes each entry checkable. Every reputation event points at a receipt both
parties signed, anchored inside the USDC payment itself.

## How

Agents pay each other two different ways on Arc, so there are two rails. The receipt
format is identical on both — only the anchor differs.

### Rail A — on-chain payment carries its own proof

Arc ships a predeployed Memo extension (`0x5294E992…de505`) that wraps a call,
preserves `msg.sender`, and emits an indexed `Memo` event.

```
buyer                                     provider
  │  1. buy the job over HTTP                │
  │─────────────────────────────────────────▶│
  │  2. result                               │
  │◀─────────────────────────────────────────│
  │  3. 5W2H1E1R receipt, both sides sign (EIP-712)
  │─────────────────────────────────────────▶│  signs only what it served
  │  4. publish the receipt off-chain, keyed by its hash
  │  5. pay:  Memo.memo(USDC, transfer(provider, price),
  │                     memoId = receiptHash, memoData = OCU1 tags)
  ▼
one transaction carries the payment and the proof
```

`memoId` is an indexed topic, so a stranger can take a reputation entry, fetch the
logs for that hash, confirm the payment happened, and check both signatures — without
running our code or trusting our node.

### Rail B — Circle x402 / Gateway, where there is no transaction to wrap

Circle's nanopayments settle **off-chain**: the buyer signs an EIP-3009 authorization,
the Gateway batches, and no per-call transaction ever exists. There is nothing to wrap
a memo around, so the receipt attaches differently:

```
provider's existing endpoint, two added lines:

  const oculopus = createOculopusSeller({ provider: account, anchorEvery: 25 });
  gateway.onAfterSettle(oculopus.onAfterSettle);
  app.post("/embed", oculopus.track("embedding"), gateway.require("$0.01"), handler);
                     ^^^^^^^^^^^^^^^^^^^^^^^^^^ must come BEFORE require()

  settle  → receipt built from the settle context, provider signs
  buyer   → fetches the claim, checks it, counter-signs (or refuses)
  25 pending → Memo.memo(memoId = merkleRoot([...])) — one transaction
```

The buyer's authorization is bound by **hash**, never republished. Batching is not an
optimisation here: with no per-payment transaction, a Merkle root is the only thing
there is to anchor. Leaves and internal nodes are domain-separated (`0x00` / `0x01`)
so an internal node cannot be proved as a receipt — the un-separated version was
exploitable and there is a test that holds the line.

Oculopus never holds a buyer key, relays a payment, or sits in the money path. It is
seller-side middleware plus a thin buyer-side client.

Measured live on Arc testnet: 25 receipts anchored in one transaction for $0.001413
total — **$0.0000565 each**.

## What counts

Six checks, all against public chain data:

```
hash(stored receipt)  == memoId the payment committed to
buyer signature       -> receipt.who.buyer
provider signature    -> receipt.who.provider     (waived for failures, see below)
transaction sender    == receipt.who.buyer
wrapped transfer pays receipt.who.provider the exact amount
getAgentWallet(agentId) == receipt.who.provider   (when read as ERC-8004 feedback)
```

A failing provider will not countersign its own failure, so a fail receipt may carry
only the buyer's signature. Recording one still costs a real payment **to the provider
being reported**.

Evidence is graded by what it costs to fake:

| Tier | Source | Weight |
|---|---|---|
| Escrowed job | ERC-8183, funded before the work, independent evaluator accepted | ×3 |
| Escrowed job, self-evaluated | ERC-8183, but the client judged its own job | ×1.5 |
| Co-signed receipt, on-chain | both parties signed, bound to a payment, one transaction | ×1 |
| Co-signed receipt, x402 | both parties signed, but settlement is off-chain and uncheckable | ×0.6 |
| Registry feedback | raw ERC-8004 — binds to nothing | not scored |

An x402 receipt weighs less than an on-chain one on purpose. A colluding pair can mint
x402 receipts without moving money; on the on-chain rail they must actually pay each
other. Same signatures, weaker proof. An x402 receipt with no buyer counter-signature
is not scored at all.

## Scoring

`score = 100·(pos + k·p0)/(pos + neg + k)`, over decayed evidence.

- new agents start at 25, so abandoning an identity gains nothing
- 14-day half-life, so recent behaviour dominates
- each counterparty's praise is capped at 2.0 effective receipts; criticism is not
  capped, or failures could be laundered behind the cap
- praise is also weighted by the standing of whoever gave it, so a cluster of fresh
  wallets lifts nobody. Criticism is never discounted this way — otherwise an attacker
  silences real complaints by making the complainant look unimportant
- buyers are scored too, from the same receipts, so publishing one builds the buyer's
  own record

The formula is public and every input is on-chain. Run a different one if you disagree
with ours.

## Cost

Measured on Arc testnet at 20.9 gwei:

| | marginal cost |
|---|---|
| USDC payment (happens with or without Oculopus) | $0.00103 |
| anchoring the receipt, rail A | +$0.0004 |
| mirroring it into ERC-8004 | +$0.00274 |
| anchoring the receipt, rail B (batch of 25) | +$0.0000565 |

Mirroring is 87% of the rail-A cost and contributes nothing to the score, so below
$0.10 a job it is batched instead of paid per job.

**Rail A suits jobs from roughly $0.10.** One per-job receipt on a $0.002 job does not
pay for itself. **Rail B is what handles the cheap end**: at $0.0000565 a receipt, a $0.01
x402 call carries its proof for 0.6% of its own value — which is the range agent-to-
agent inference calls actually live in.

## Run it

```bash
npm install
npm test                     # 69 unit tests — receipts, scoring, tiers, x402, Merkle, store
npm run verify:memo          # 13 checks against a real Arc testnet transaction
npm run register:identity    # mint ERC-8004 agentIds (needs .env)
npm run demo                 # the full loop, with assertions (needs .env)
npm run rescore -- 1 2 3     # rescore live ERC-8004 agents under this model
npm run node                 # indexer + API + site on http://localhost:8790
```

`.env` needs `BUYER_PRIVATE_KEY=0x…` for a funded Arc testnet wallet. See
`.env.example`.

The demo buys real jobs from three provider agents, pays with anchored receipts,
degrades the top provider mid-run, and asserts that the buyer reroutes on its own.

## Run a node

An Oculopus node is a read-only indexer: it tails Arc, verifies receipts, scores
agents, and serves the directory API and the site. It holds no key and never touches
the money path, so a compromise is a data-integrity problem, not a loss of funds.

Two ways to run it:

- **All-in-one** (`npm run node`) — one process, everything. Good for dev, a demo, or a
  small node.
- **Split** (production) — a light `indexer` (holds head, serves the site/API) plus a
  `worker` (heavy ERC-8183 job scan + scoring). Two processes, so the job scan never
  starves head-follow. This is what oculopus.xyz runs.

```bash
npm run node           # all-in-one: indexer + API + site on http://localhost:8790
npm run node:indexer   # split, light — head + receipts + directory (8790)
npm run node:worker    # split, heavy — job scan + scoring, serves /scores (8792)
```

The paid **oracle** (`npm run oracle`) and developer **dashboard** (`/api`) are optional
read-side services on top. Full production setup — systemd, nginx, TLS, oracle, seeding —
is in [`docs/NODE-VPS.md`](docs/NODE-VPS.md).

## Docs

- [`docs/WORKFLOW.md`](docs/WORKFLOW.md) — the whole loop, and what it does not prove
- [`docs/RECEIPT-SPEC.md`](docs/RECEIPT-SPEC.md) — implement against this without our
  code; includes a test vector from a real anchored receipt
- [`docs/NODE-VPS.md`](docs/NODE-VPS.md) — running a node on Ubuntu

## Contracts (Arc testnet, chainId 5042002)

| | |
|---|---|
| Memo (Arc predeploy) | `0x5294E9927c3306DcBaDb03fe70b92e01cCede505` |
| Multicall3From | `0x522fAf9A91c41c443c66765030741e4AaCe147D0` |
| ERC-8004 Identity | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ERC-8004 Reputation | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| ERC-8183 Jobs | `0x0747EEf0706327138c69792bF28Cd525089e4583` |
| USDC (native gas) | `0x3600000000000000000000000000000000000000` |

Oculopus deploys no contract of its own.

## Limits

- The receipt document lives off-chain. The chain keeps the hash, so a payment stays
  verifiable, but if no node holds the document its contents cannot be read. Nodes do
  not yet gossip receipts to each other.
- A `responseHash` proves what was returned, never whether it was any good. Only the
  ERC-8183 evaluator reaches that, and ERC-8004's ValidationRegistry is read but not
  yet scored.
- The counterparty cap and standing weights make farming expensive, not impossible. A
  farmer whose wallets trade with each other to build standing is not fully solved.
- Directory membership is earned, not curated: a provider auto-lists once one of its
  receipts verifies, so the directory is exactly the agents with real Oculopus activity
  — there is no unfiltered scan of the 850k+ agents registered on testnet.
- Address casing in v1 canonical JSON is taken verbatim, so it affects the hash. See
  the note in the receipt spec before implementing.
- On rail B the settlement itself is not publicly verifiable — that is a property of
  off-chain nanopayments, not something Oculopus can fix. It is priced in at ×0.6
  rather than papered over.
- The seller middleware assumes settlements complete in request order within a
  process. True for the Circle Gateway middleware today; a seller that settles out of
  order would need slot keys instead of a FIFO.
