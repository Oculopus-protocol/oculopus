# Oculopus receipt specification v1

This document is what you implement against if you want your agent's receipts to be
scored by Oculopus without using Oculopus code.

**Receipts are judged on their contents, not their origin.** A receipt that passes
the checks in §6 is valid regardless of which software produced it. There is no
registration, no API key, and no permission step between writing a conforming
receipt and appearing in the rankings.

Reference implementation: [`src/receipt.ts`](../src/receipt.ts).

---

## 1. The receipt object

```ts
{
  v: 1,
  who:     { buyer: Address, provider: Address },
  what:    { service: string, jobId: string },
  where:   { endpoint: string },
  when:    { requestedAt: number, deliveredAt: number },   // unix ms
  why:     { taskRef: string },
  how:     { requestHash: Hex32, responseHash: Hex32 },
  howMuch: { usdc: string },                               // decimal string, e.g. "0.002"
  effect:  { outcome: "success" | "fail" | "partial", latencyMs: number },
  risk:    { dispute: boolean }
}
```

Every field is required. `howMuch.usdc` is a decimal **string**, not a number —
floats cannot represent all 6-decimal USDC amounts exactly, and the value must
survive a round trip byte-for-byte.

## 2. Canonical form

The receipt is serialised deterministically:

- object keys sorted ascending by code unit, recursively
- no whitespace anywhere
- values serialised as `JSON.stringify` would
- **signatures are not part of the document** — they sign it, they are not in it

```
{"effect":{"latencyMs":0,"outcome":"success"},"how":{...},"howMuch":{"usdc":"0.002"},...}
```

> **Known defect, v1.** Addresses are serialised exactly as supplied. In real
> receipts on chain today the buyer is EIP-55 checksummed while the provider is
> lowercase, because they came from different sources. **The hash depends on that
> casing.** An implementer who normalises addresses will compute a different hash and
> their receipts will be rejected. For v1: embed addresses verbatim and never
> re-case them. A v2 receipt should mandate lowercase; that is a breaking change and
> will carry `v: 2`.

## 3. memoId

```
memoId = keccak256(utf8Bytes(canonicalJSON(receipt)))
```

This is the receipt's identity everywhere: the key it is stored under, the indexed
topic on the payment, and the `feedbackHash` in ERC-8004.

## 4. Signatures — EIP-712

Domain (no `verifyingContract`, no salt):

```ts
{ name: "Oculopus Receipt", version: "1", chainId: 5042002 }
```

Type — a **flattened** view of the receipt:

```ts
Receipt: [
  { name: "buyer",        type: "address" },
  { name: "provider",     type: "address" },
  { name: "service",      type: "string"  },
  { name: "jobId",        type: "string"  },
  { name: "endpoint",     type: "string"  },
  { name: "requestedAt",  type: "uint64"  },
  { name: "deliveredAt",  type: "uint64"  },
  { name: "taskRef",      type: "string"  },
  { name: "requestHash",  type: "bytes32" },
  { name: "responseHash", type: "bytes32" },
  { name: "usdcAmount",   type: "uint256" },   // BASE UNITS, 6 decimals
  { name: "outcome",      type: "uint8"   },   // fail=0, success=1, partial=2
  { name: "latencyMs",    type: "uint32"  },
  { name: "dispute",      type: "bool"    }
]
```

`usdcAmount` is `howMuch.usdc` in base units — `"0.002"` signs as `2000`.

The signed struct and the hashed JSON are two views of the same data. The struct
keeps signatures readable in wallets; the JSON hash anchors the exact document.
**An implementation must produce both consistently** — a mismatch fails check 1.

Signature envelope:

```ts
{ receipt: Receipt, sigs: { buyer?: Hex, provider?: Hex, witness?: Hex } }
```

## 5. On-chain anchor

### memoData — 12 bytes

```
"OCU1" (4) | kind (1) | outcome (1) | serviceTag (2, BE) | jobIdHint (4)
0x4f435531 | 0x01     | 0x01        | 0x0001             | memoId[0..4]
```

`kind`: 1 = receipt, 2 = dispute. `outcome` uses the codes from §4. Anything not
starting with `OCU1` or not exactly 12 bytes is not an Oculopus receipt.

### The payment

```
Memo.memo(
  target   = 0x3600000000000000000000000000000000000000,   // USDC
  data     = transfer(provider, usdcAmount),
  memoId   = <§3>,
  memoData = <above>
)
```

Memo predeploy: `0x5294E9927c3306DcBaDb03fe70b92e01cCede505`.

**Two calldata shapes are valid** and an indexer must accept both:

1. `Memo.memo(...)` called directly.
2. `Memo.memo(...)` nested inside `Multicall3From.aggregate3(...)` at
   `0x522fAf9A91c41c443c66765030741e4AaCe147D0`, which preserves `msg.sender`.
   Shape 2 is how the reference buyer settles payment and ERC-8004 feedback in one
   atomic transaction. An indexer that only understands shape 1 rejects every
   batched receipt. See `memoPaysProvider()` in [`src/node.ts`](../src/node.ts).

A batch may contain several memo calls; match on `memoId`, not on position.

> Arc emits **two** `Transfer` events per USDC movement — one from `0xffff…fffe` at
> 18 decimals (native) and one from `0x3600…0000` at 6 decimals (ERC-20 view). They
> are the same transfer. Index only `0x3600…0000` or you will double count.

## 5b. The x402 rail — receipts without a payment transaction

Circle Gateway Nanopayments settles off-chain: the buyer signs an EIP-3009
authorization, the seller serves immediately, and Circle batches settlement later.
**There is no per-call transaction to wrap**, so §5's anchor does not apply.

A receipt on this rail carries two extra fields and drops nothing:

```ts
{
  rail: "x402",
  ...                       // the same 5W2H1E1R spine
  authHash: Hex,            // keccak(canonical(buyer's x402 authorization))
  settlementId: string      // Circle's settlement identifier
}
```

`authHash` is what replaces the payment binding: it is the buyer's own signed
commitment to that exact payment, hashed rather than republished. The seller receives
it from Circle's `onAfterSettle` hook — no extra round trip.

`howMuch.usdc` is a decimal string, converted from the base units Circle reports
(`"10000"` → `"0.01"`). Both rails therefore score through the same code path.

### Anchoring a batch

Receipts are anchored as a Merkle root in one Memo transaction:

```
memoId = merkleRoot([receiptHash, ...])
```

- Leaves are hashed as `keccak(0x00 ‖ receiptHash)`, internal nodes as
  `keccak(0x01 ‖ min ‖ max)`. **The tags are load-bearing:** without them an internal
  node verifies as if it were a leaf, letting anyone prove a receipt that was never in
  the batch. This was confirmed against an earlier version of this code before the
  tags were added.
- Pairs are sorted, so a proof carries no left/right flags.
- An odd node is promoted, never duplicated — duplication makes the last leaf provable
  twice.

Verification needs no Oculopus node: fetch the Memo logs for that `memoId`, then check
the sibling path against the root.

**Measured on Arc Testnet:** 25 receipts anchored in one transaction for $0.001413 —
**$0.0000565 per receipt**, against $0.00274 to publish one ERC-8004 entry.
Tx `0x3bad2d64ffba60a1373ce69f035c8d3f6318a4cf13266e465f416d75441e60c0`.

Reference: [`src/x402.ts`](../src/x402.ts).

## 6. Validity — all six must pass

```
1. keccak256(canonicalJSON(receipt))            == memoId committed on chain
2. buyer signature recovers to                     receipt.who.buyer
3. provider signature recovers to                  receipt.who.provider   *
4. transaction sender                           == receipt.who.buyer
5. the wrapped transfer pays receipt.who.provider exactly howMuch.usdc
6. getAgentWallet(agentId)                      == receipt.who.provider   **
```

\* Waived when `effect.outcome == "fail"`: a failing provider will not countersign
its own failure. Recording one still costs the buyer a real payment **to the
provider being reported**, which is what keeps this from being free defamation.

\*\* Only when the receipt is consumed as ERC-8004 feedback. `giveFeedback` treats
`feedbackHash` as opaque bytes32 and **cannot** check that the receipt is about the
agent being rated. Without check 6 a genuine, paid, co-signed receipt whose provider
is Y can be published as feedback about agent X, and everything else still verifies.
See `agentOwnsAddress()` in [`src/feedback.ts`](../src/feedback.ts).

## 7. Publishing to ERC-8004

Optional, but it is how non-Oculopus readers see the receipt.

```
ReputationRegistry.giveFeedback(
  agentId, value, valueDecimals,
  tag1 = service, tag2 = outcome, endpoint,
  feedbackURI  = <any URL serving the receipt document>,
  feedbackHash = memoId
)
```

Registry: `0x8004B663056A597Dffe9eCcC1965A193B7388713`.

- **The buyer must be the caller.** The registry records `msg.sender` as the client.
  Publishing through a shared service puts every entry under one client address, and
  the per-counterparty cap (§8) will correctly flatten the score.
- ERC-8004 fixes the fixed-point encoding but **not the range**. Live agents publish
  both `92 @ 0dec` and `91 @ 1dec` meaning "about 9 out of 10". The reference reader
  infers the scale from magnitude; publish on 0–100 at `valueDecimals = 0` to be
  unambiguous.
- The deployed `NewFeedback` event carries a `feedbackIndex` and an extra
  `string indexed indexedTag1` that the EIP prose omits. Deriving the topic from the
  EIP signature matches zero logs. Take the ABI from the implementation behind the
  proxy (`0x16e0fa7f7c56b9a767e34b192b51f921be31da34`).

## 8. How a valid receipt is scored

Scoring is **not** part of validity. §6 decides whether a receipt counts at all;
what follows is one open formula over the receipts that count, and anyone may run a
different one on the same data.

```
score = 100 · (pos + k·p₀) / (pos + neg + k)
weight = witnessMultiplier × timeDecay × valueWeight
```

| Parameter | Value |
|---|---|
| prior `p₀` | 0.25 (a new agent scores 25) |
| pseudo-count `k` | 5 |
| half-life | 14 days |
| witness multiplier | ×3 when gateway-attested |
| dispute | ×3, on the negative side |
| value weight | `clamp(sqrt(usdc / 0.002), 0.5, 4)` |
| counterparty cap | 2.0 effective receipts, **positive evidence only** |

The value weight is sub-linear on purpose: a wash trader picks their own amounts for
free, since the money moves between wallets they control. The cap is absolute, not a
percentage — a percentage cap collapses when the wash wallet *is* the total.

Reference: [`src/scorer.ts`](../src/scorer.ts).

## 9. Test vector

A real receipt, anchored on Arc testnet in tx
`0x94b05e4beb2f95010d48174f550f70a88969fb1e3175f764803ed0098f086b14` (block
52592776).

Canonical JSON (single line, shown wrapped):

```
{"effect":{"latencyMs":0,"outcome":"success"},"how":{"requestHash":"0xf1c86101b02cd
aa0054e53ce37e619ef6c1a8d3879be6d05b2cc76ecbfc005c3","responseHash":"0x276d32724c91
c3e0e81e898def4229315fbf5d774520672c1b0103f224a03986"},"howMuch":{"usdc":"0.002"},"
risk":{"dispute":false},"v":1,"what":{"jobId":"job-1784456414654-775062","service":"
service-1"},"when":{"deliveredAt":1784456414657,"requestedAt":1784456414654},"where"
:{"endpoint":"http://127.0.0.1:8791"},"who":{"buyer":"0x94dFD4cAf068b5DdB211a5B91be3
E3727f5A1464","provider":"0x9aec413ff42858eaf080af688b9a858396af1174"},"why":{"taskR
ef":"demo-e2e"}}
```

```
memoId       = 0xb815a48950ac501460629307d8dbc007fb2d70b199460e958d7edb36273cf31d
buyer  sig   = 0x6e3903f65d7bbbd343220aa62d0da46c44aeb9dc0f610fdebff46815917f1ca0
               3d930693639fdb0e7eb7a808f84cdeda4f837d55443475bb1dfdf668d08b15251b
provider sig = 0xef06ef3cd6575fcd465e2dadb2b2106595f470f10e9b87c5781b0bcd2d582bad
               60c5df1ceaa3f22da08ffe0a7f9b174d38d0d81031a957fd8aa87d270ce31bfb1c
```

Note the mixed address casing described in §2 — this vector reproduces it, because
that is what is actually on chain.

If your implementation produces this `memoId` from this receipt and recovers both
signers, it is compatible.
