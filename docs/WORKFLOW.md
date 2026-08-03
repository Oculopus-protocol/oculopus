# How Oculopus works, end to end

## The problem in one line

When one agent pays another on-chain, the ledger records who paid whom and how
much. It does not record *what was bought*, *whether it was delivered*, or *whether
it was any good*. So an agent choosing a counterparty has nothing to go on, and
falls back to a hard-coded allowlist.

ERC-8004 gives Arc a standard place to publish reputation — but its feedback is
**one signature from the client**. The rated agent never signs, and nothing ties the
rating to a payment. Anyone can write anything about anyone.

Oculopus supplies the missing binding: every reputation event points at a receipt
that **both parties signed** and that is **anchored on Arc**.

There are two payment rails and therefore two ways a receipt anchors. Steps 0–4 and
7–9 below are shared by both; step 5 is where they diverge. Rail A (on-chain USDC)
anchors inside the payment transaction itself. Rail B (Circle x402 / Gateway) has no
per-payment transaction to wrap, so a batch of receipts anchors under one Merkle
root — see §5b.

---

## Cast

| Actor | Holds a key? | Role |
|---|---|---|
| Buyer agent | yes | Picks a provider by score, buys, co-signs, pays, publishes feedback |
| Provider agent | yes | Serves the job, countersigns successful receipts. On rail B it signs first and the buyer counter-signs |
| Node | **no** | Indexes, verifies, scores, serves the directory |
| Circle Gateway | — | Settles rail-B payments off-chain. Not an Oculopus component; Oculopus only hooks `onAfterSettle` |

Arc contracts used:

| Contract | Address | Role |
|---|---|---|
| Memo (Arc predeploy) | `0x5294E9927c3306DcBaDb03fe70b92e01cCede505` | Wraps a call, preserves `msg.sender`, emits an indexed `memoId` |
| USDC (native gas) | `0x3600000000000000000000000000000000000000` | Settlement, 6 decimals |
| ERC-8004 IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | agentId as an ERC-721 token |
| ERC-8004 ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | Public feedback event bus |
| ERC-8183 Jobs | `0x0747EEf0706327138c69792bF28Cd525089e4583` | Escrowed jobs, read as the strongest evidence tier |
| Multicall3From | `0x522fAf9A91c41c443c66765030741e4AaCe147D0` | Batches memo calls while preserving `msg.sender` |

---

## The loop

### 0. Identity — once per agent

`src/registerIdentity.ts` → `IdentityRegistry.register(agentURI)` mints an agentId
owned by the agent's wallet. This is a standard ERC-8004 identity, readable by
anything that speaks ERC-8004, not only by Oculopus.

The node re-checks `ownerOf(agentId)` for every agent it lists, so a tampered local
file cannot make it advertise an agent whose wallet does not own that id.

### 1. Selection — `src/agents/buyer.ts`

The buyer GETs `/directory?serviceTag=N` and takes the highest-scored provider.
Occasionally it explores a runner-up instead, rotating which one, so backups keep a
current score rather than decaying into permanent unknowns.

### 2. The job

Plain HTTP `POST {endpoint}/job`. Oculopus does not define the service protocol —
it only cares that something was requested and something came back.

### 3. The receipt — `src/receipt.ts`

A 5W2H1E1R record:

| Field | Contents |
|---|---|
| `who` | buyer + provider addresses |
| `what` | service, jobId |
| `where` | endpoint |
| `when` | requestedAt, deliveredAt |
| `why` | task reference |
| `how` | requestHash, responseHash |
| `howMuch` | USDC amount |
| `effect` | outcome, latencyMs |
| `risk` | dispute flag |
| `v` | schema version |

`receiptHash()` is the keccak of the canonical JSON. **That hash is the memoId.**

### 4. Co-signature

Both parties sign the same fields as EIP-712 typed data (domain
`Oculopus Receipt`, version `1`). The provider countersigns only if it actually
served the job, at the exact response hash and price it served.

A **failure** receipt may be buyer-only — a failing provider will not sign its own
failure. That asymmetry is deliberate, and step 6 is what keeps it from being a
defamation tool.

### 5a. Payment and anchor, rail A — one transaction

```
Memo.memo(
  target   = USDC,
  data     = transfer(provider, amount),
  memoId   = keccak256(receipt),
  memoData = OCU1|kind|outcome|serviceTag|hash-hint
)
```

The Memo extension forwards the call with `msg.sender` preserved, so the buyer's own
wallet pays. The event carries `memoId` as an **indexed topic**, so anyone can fetch
a receipt's anchor by hash, and `callDataHash` binds the memo to that exact
transfer — you cannot attach a receipt to a different payment.

Cost: about **$0.002 per receipt**.

### 5b. Payment and anchor, rail B — Circle x402 / Gateway

Circle's nanopayments settle off-chain. The buyer signs an EIP-3009 authorization, the
Gateway batches and settles, and **no per-call transaction exists**. Steps 1–4 above
still happen; step 5a cannot.

A provider adds two lines to an endpoint it already runs:

```ts
const oculopus = createOculopusSeller({ provider: account, anchorEvery: 25 });
gateway.onAfterSettle(oculopus.onAfterSettle);
app.post("/embed", oculopus.track("embedding"), gateway.require("$0.01"), handler);
```

**`track()` must come before `require()`.** The Gateway middleware settles inline, so
`onAfterSettle` fires while `require()` is still running. Reverse the order and the
settle hook finds no tracked request: the receipt comes out with service `unknown`, an
empty endpoint, and the hash of an empty body — which a correct buyer then refuses to
counter-sign. This was seen live before the order was fixed, and the middleware now
warns loudly instead of producing such a receipt.

What happens per call:

1. `track()` records the route, body hash and timestamp in a per-request slot.
2. The Gateway settles; `onAfterSettle` claims the oldest unclaimed slot and builds
   the receipt from the settle context. Amounts arrive in base units (`"10000"`) and
   are converted to the same decimal string an on-chain receipt carries (`"0.01"`), so
   both rails score through one code path.
3. The buyer's EIP-3009 authorization is hashed into `authHash`. The signature itself
   never enters the receipt.
4. The provider signs the receipt hash (EIP-712) and returns it. Circle's
   `GatewayClient.pay()` exposes no response headers, so the buyer fetches the claim
   by settlement id from `/oculopus/receipt/:settlementId`.
5. The buyer checks it before endorsing: does the receipt hash to the claimed value,
   does it name *me* as buyer, does the signature recover to the named provider, do
   the request and response hashes match what I actually sent and received, was I
   charged no more than agreed. Any mismatch is refused, not signed. A buyer that
   counter-signs whatever it is handed has turned its own reputation into a rubber
   stamp.
6. Every `anchorEvery` receipts, one transaction anchors the batch:

```
Memo.memo(memoId = merkleRoot([receiptHash, receiptHash, ...]))
```

Leaves and internal nodes are domain-separated — leaf = `keccak(0x00‖h)`, node =
`keccak(0x01‖min‖max)`. Without the tags an attacker can take an internal node out of
a published tree and prove it was a receipt that was never in the batch; that was
reproducible before the fix and there is now a test asserting it fails.

Anyone can verify membership without an Oculopus node: check the Merkle proof locally,
then `eth_getLogs` the Memo contract filtered on the root.

Cost measured live: **25 receipts anchored in one transaction for $0.001413 — $0.0000565
each.**

Oculopus holds no buyer key, relays no payment, and is not in the money path on either
rail.

### 6. ERC-8004 feedback — `src/feedback.ts`

The buyer calls:

```
ReputationRegistry.giveFeedback(
  agentId, value, valueDecimals,
  tag1 = service, tag2 = outcome, endpoint,
  feedbackURI  = <node>/receipts/<memoId>,
  feedbackHash = memoId
)
```

`feedbackHash` is the same memoId as the payment. That single field is what makes
the entry checkable by a stranger:

1. Take `feedbackHash` from the ERC-8004 event.
2. `eth_getLogs` the Memo contract filtered on that `memoId` → find the payment.
3. Confirm the payer is the same wallet that wrote the feedback.
4. Fetch `feedbackURI` → the receipt document → verify both EIP-712 signatures.

No Oculopus node is needed for steps 1–3. *(Verified live: 3/3 sampled entries.)*

**Feedback is published by the buyer, never by the node.** If a node published on
everyone's behalf, every entry would share one client address, and the
per-counterparty cap below would correctly flatten every score it touched.

### 7. Verification — `src/node.ts`

A rail-A receipt feeds reputation only after **all six** checks pass:

```
✓ hash(stored receipt) == memoId the payment committed to
✓ buyer signature recovers to receipt.who.buyer
✓ provider signature recovers to receipt.who.provider   (waived for fail receipts)
✓ transaction sender == receipt.who.buyer
✓ the wrapped transfer pays receipt.who.provider the exact amount
✓ getAgentWallet(agentId) == receipt.who.provider
```

The last check exists because `giveFeedback` treats `feedbackHash` as opaque
`bytes32`. Without it, a genuine receipt about provider Y can be published as feedback
about agent X and every other check still passes.

A rail-B receipt is scored only when **both** are true: the batch root is anchored
on-chain, and the buyer has counter-signed. Either alone is a provider talking about
itself. The node looks *backwards* for the anchor at ingest — an anchor lands before
the receipt is published, so a forward-only scan finds nothing (measured: anchor at
block 52945592 while the indexer was already at 52946134).

Anything else is rejected and logged. Every check runs off public chain data, so a
third party can rerun all of them.

### 8. Scoring — `src/scorer.ts`

```
score = 100 · (pos + k·p₀) / (pos + neg + k)
```

| Parameter | Value | Why |
|---|---|---|
| prior `p₀` | 0.25 | A new agent scores 25, so discarding an identity gains nothing |
| pseudo-count `k` | 5 | How much evidence moves you off the prior |
| half-life | 14 days | Recent behaviour dominates; no coasting, no permanent scars |
| evidence tier | ×3 … ×0.6 | Graded by what the evidence costs to fake — table below |
| counterparty standing | 0.15 – 1.0 | Praise is worth what its author is worth |
| value weight | 0.75 – 1.5 | A larger job weighs a little more — deliberately narrow |
| dispute weight | ×3 negative | A contested job hurts more than a plain failure |
| counterparty cap | 2.0, positive only | One wallet contributes at most 2 effective receipts of praise |

| Evidence tier | Weight |
|---|---|
| ERC-8183 job, independent evaluator | ×3 |
| ERC-8183 job, self-evaluated | ×1.5 |
| Co-signed receipt, on-chain payment | ×1 |
| Co-signed receipt, x402 settlement | ×0.6 |
| Raw ERC-8004 feedback | 0 |

Standing is propagated, not assumed: a wallet's praise carries weight in proportion to
its own score, floored at 0.15 so a new buyer is quiet rather than silent. **Criticism
is never discounted this way** — otherwise an attacker silences real complaints by
first making the complainant look unimportant.

Buyers are scored from the same receipts. Publishing a receipt costs the buyer gas and
lifts the provider; left there it is charity and a rational buyer stops. A buyer's
score rises on jobs the provider also signed and falls on failures the provider never
signed — the only receipt a buyer can write alone.

The cap is **absolute, not relative**. A relative cap ("no more than 20% of total")
is self-referential and collapses when the wash wallet *is* the total — the
anti-wash unit test caught exactly that. Negative evidence is uncapped, so failures
cannot be laundered behind the cap.

### 9. Routing

Scores change, the buyer re-reads the directory, and traffic moves. In the live E2E
run the top provider was degraded mid-run and the buyer rerouted on its own at round
11 (46.4 → 36.1, below the 37.5 runner-up). No human, no dashboard click.

---

## Two numbers, deliberately

The dashboard shows both:

- **ERC-8004 raw** — the mean of everything published to the registry.
- **Oculopus** — the same agents, counting only payment-backed co-signed receipts,
  with the counterparty cap applied.

Measured on live testnet data:

| agentId | clients | feedback | registry avg | Oculopus | top client share |
|---|---|---|---|---|---|
| 1 | 1284 | 113502 | 86.1% | 99.9 | 66.8% |
| 2 | 1 | 5 | 91.0% | 46.4 | 100% |

Agent 2 looks excellent by registry average and mediocre under the cap, because
every rating came from one wallet. Agent 1's reputation is spread across 1284
clients, so the cap barely touches it — even though one wallet wrote 75,796 of its
entries, those collapse to at most 2.0 effective receipts.

**The gap measures concentration, not fraud.** These are public numbers about public
behaviour; nothing here establishes intent.

---

## What this does and does not prove

**Does prove**
- A payment of a stated amount happened, from buyer to provider.
- Both parties signed a specific description of the job (or, for failures, the buyer
  signed and paid for the privilege of saying so).
- The reputation event and the payment refer to the same receipt.
- Every score is recomputable by anyone from public data.

**Does not prove**
- That the delivered work was *good*. `responseHash` proves what was returned, not
  its quality.
- That two colluding agents did not trade real payments to manufacture history. The
  cap makes this expensive per counterparty; it does not make it impossible.
- On rail B, that the payment settled at all. Circle's settlement is off-chain and not
  publicly checkable, which is why those receipts weigh ×0.6 and require the buyer's
  counter-signature before they count. A colluding pair can mint them without moving
  money; on rail A they must actually pay each other.
- Anything about agents with no receipts. They sit at the 25 prior — unknown, not
  bad.

## Where things live

| Data | Location | Regenerable? |
|---|---|---|
| Receipt hash, payment, outcome tags | Arc chain (Memo event) | authoritative |
| Batch Merkle root, rail B | Arc chain (Memo event) | authoritative |
| agentId, owner, agentURI | Arc chain (IdentityRegistry) | authoritative |
| Feedback, ratings, feedbackHash | Arc chain (ReputationRegistry) | authoritative |
| Receipt document | node `data/state.json`, served at `/receipts/:hash` | **no** — off-chain |
| Scores, index progress | node `data/` | yes, from chain |

The receipt document is the one thing not on-chain, and it is the current weak
point: it is held by whichever node received it. See `docs/NODE-VPS.md`.
