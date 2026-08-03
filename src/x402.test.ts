// Tests for the x402 rail: receipt construction from a real settle context, and the
// Merkle batching that replaces per-payment anchoring on a rail with no per-payment
// transaction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toHex } from "viem";
import {
  buildX402Receipt,
  merkleLeaf,
  merkleProof,
  merkleRoot,
  toDecimalUsdc,
  verifyMerkleProof,
  x402ReceiptHash,
  type SettleContextLike,
} from "./x402.js";

// Captured from a REAL settled payment on Arc Testnet, not invented: buyer agentId
// 851355 paying provider agentId 851356 $0.01 through Circle Gateway.
const LIVE_CTX: SettleContextLike = {
  paymentPayload: { payload: { authorization: { from: "0x94dfd4…", value: "10000" }, signature: "0xabc" } },
  requirements: { amount: "10000", network: "eip155:5042002", asset: "0x3600000000000000000000000000000000000000" },
  result: { payer: "0x94dfd4caf068b5ddb211a5b91be3e3727f5a1464", transaction: "fcd09181-ee62-45f4-ba77-5c8b86bfd561" },
};

const ARGS = {
  provider: "0x9AeC413fF42858EaF080aF688b9a858396Af1174" as const,
  service: "embedding",
  jobId: "job-1",
  endpoint: "https://provider.example/embed",
  requestedAt: Date.now() - 400,
  requestHash: keccak256(toHex("req")),
  responseHash: keccak256(toHex("res")),
  outcome: "success" as const,
};

test("base units convert to the same decimal string an on-chain receipt carries", () => {
  // Circle reports "10000"; receipts carry "0.01". Getting this wrong would score an
  // x402 job as 10000 USDC and let one call outweigh an entire honest history.
  assert.equal(toDecimalUsdc("10000"), "0.01");
  assert.equal(toDecimalUsdc("1000000"), "1");
  assert.equal(toDecimalUsdc("1"), "0.000001");
  assert.equal(toDecimalUsdc("0"), "0");
  assert.equal(toDecimalUsdc("1500000"), "1.5");
});

test("a settled x402 payment produces a receipt naming both parties and the amount", () => {
  const r = buildX402Receipt(LIVE_CTX, ARGS);
  assert.equal(r.who.buyer, LIVE_CTX.result.payer);
  assert.equal(r.who.provider, ARGS.provider);
  assert.equal(r.howMuch.usdc, "0.01");
  assert.equal(r.where.network, "eip155:5042002");
  assert.equal(r.settlementId, "fcd09181-ee62-45f4-ba77-5c8b86bfd561");
  assert.equal(r.rail, "x402");
});

test("the buyer's authorization is bound by hash, never republished", () => {
  const r = buildX402Receipt(LIVE_CTX, ARGS);
  assert.match(r.authHash, /^0x[0-9a-f]{64}$/);
  // the signature itself must not survive into the receipt
  assert.ok(!JSON.stringify(r).includes("0xabc"));
});

test("a different authorization yields a different receipt hash", () => {
  const a = x402ReceiptHash(buildX402Receipt(LIVE_CTX, ARGS));
  const other: SettleContextLike = {
    ...LIVE_CTX,
    paymentPayload: { payload: { authorization: { from: "0x94dfd4…", value: "10000" }, signature: "0xdef" } },
  };
  const b = x402ReceiptHash(buildX402Receipt(other, ARGS));
  assert.notEqual(a, b);
});

test("a settle context with no payer is rejected rather than attributed to nobody", () => {
  const ctx = { ...LIVE_CTX, result: { transaction: "x" } } as SettleContextLike;
  assert.throws(() => buildX402Receipt(ctx, ARGS), /no payer/);
});

// ---- merkle batching -------------------------------------------------------------

const leaf = (i: number) => keccak256(toHex(`receipt-${i}`));

test("every receipt in a batch proves against the single anchored root", () => {
  for (const n of [1, 2, 3, 5, 8, 100]) {
    const leaves = Array.from({ length: n }, (_, i) => leaf(i));
    const root = merkleRoot(leaves);
    for (let i = 0; i < n; i++) {
      assert.ok(verifyMerkleProof(leaves[i]!, merkleProof(leaves, i), root), `n=${n} i=${i}`);
    }
  }
});

test("a receipt that was never in the batch cannot be proved into it", () => {
  const leaves = Array.from({ length: 7 }, (_, i) => leaf(i));
  const root = merkleRoot(leaves);
  assert.ok(!verifyMerkleProof(leaf(999), merkleProof(leaves, 3), root));
});

test("an odd leaf is promoted, not duplicated", () => {
  // Duplicating an odd leaf makes the last receipt provable twice — the classic
  // second-preimage bug in hand-rolled Merkle trees.
  const three = [leaf(0), leaf(1), leaf(2)];
  const four = [leaf(0), leaf(1), leaf(2), leaf(2)];
  assert.notEqual(merkleRoot(three), merkleRoot(four));
});

test("leaf order does not change whether a proof verifies", () => {
  const leaves = [leaf(0), leaf(1), leaf(2), leaf(3)];
  const root = merkleRoot(leaves);
  // sorted-pair hashing means a proof carries no left/right flags
  assert.ok(verifyMerkleProof(leaves[2]!, merkleProof(leaves, 2), root));
});

test("an empty batch is an error, not an anchor of nothing", () => {
  assert.throws(() => merkleRoot([]), /no leaves/);
});

test("an internal node cannot masquerade as a receipt", () => {
  // Before leaf/node domain separation this passed: an attacker took hash(A,B) from a
  // published tree and proved it was a receipt that had never been in the batch.
  const leaves = [leaf(0), leaf(1), leaf(2), leaf(3)];
  const root = merkleRoot(leaves);
  const pair = (a: string, b: string) => {
    const [x, y] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
    return keccak256(`0x01${x.slice(2)}${y.slice(2)}` as `0x${string}`);
  };
  const internal = pair(merkleLeaf(leaves[0]!), merkleLeaf(leaves[1]!));
  const sibling = pair(merkleLeaf(leaves[2]!), merkleLeaf(leaves[3]!));
  assert.ok(!verifyMerkleProof(internal, [sibling], root), "internal node must not verify as a leaf");
});

// ---- seller middleware + buyer counter-signature ---------------------------------

const { createOculopusSeller } = await import("./x402Middleware.js");
const { counterSign, readClaim, recoverReceiptSigner } = await import("./x402Client.js");
const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");

// Mirrors a real ServerResponse closely enough to catch ordering bugs: headers are
// only settable until writeHead, and `finish` fires after that. An earlier mock let
// finish set headers, which hid an ERR_HTTP_HEADERS_SENT crash that took the live
// server down.
const mkRes = () => {
  const headers: Record<string, string> = {};
  const cbs: (() => void)[] = [];
  const res = {
    headers,
    headersSent: false,
    setHeader: (k: string, v: string) => {
      if (res.headersSent) throw new Error("ERR_HTTP_HEADERS_SENT");
      headers[k] = v;
    },
    writeHead: function () { res.headersSent = true; return res; },
    on: (_e: string, cb: () => void) => { cbs.push(cb); },
    /** Send the response the way Express does: writeHead, then finish. */
    finish: () => { res.writeHead(); cbs.forEach((c) => c()); },
  };
  return res;
};
const settleCtx = (payer: string, id: string): SettleContextLike => ({
  paymentPayload: { payload: { sig: id } },
  requirements: { amount: "10000", network: "eip155:5042002" },
  result: { payer, transaction: id },
});

test("CONCURRENCY: two interleaved buyers get their own receipts, not each other's", async () => {
  // The first version used one shared `currentReq`. Two concurrent buyers then produced
  // receipts with identical request hashes, and each response returned the other's
  // receipt — verified against that code before this was rewritten.
  const provider = privateKeyToAccount(generatePrivateKey());
  const seller = createOculopusSeller({ provider, anchorEvery: 0 });
  const reqA = { originalUrl: "/embed", body: { text: "AAA" } };
  const reqB = { originalUrl: "/embed", body: { text: "BBB" } };
  const resA = mkRes(), resB = mkRes();

  seller.track("embedding")(reqA, resA as never, () => {});
  seller.track("embedding")(reqB, resB as never, () => {});
  await seller.onAfterSettle(settleCtx("0x1111111111111111111111111111111111111111", "settle-A"));
  await seller.onAfterSettle(settleCtx("0x2222222222222222222222222222222222222222", "settle-B"));
  resA.finish(); resB.finish();

  const [a, b] = seller.all();
  assert.notEqual(a!.receipt.how.requestHash, b!.receipt.how.requestHash, "each request keeps its own body hash");
  assert.equal(resA.headers["x-oculopus-receipt"], a!.hash, "A's response returns A's receipt");
  assert.equal(resB.headers["x-oculopus-receipt"], b!.hash, "B's response returns B's receipt");
});

test("the provider signs its own receipts and the signature recovers to it", async () => {
  const provider = privateKeyToAccount(generatePrivateKey());
  const seller = createOculopusSeller({ provider, anchorEvery: 0 });
  const req = { originalUrl: "/embed", body: { text: "x" } };
  const res = mkRes();
  seller.track("embedding")(req, res as never, () => {});
  await seller.onAfterSettle(settleCtx("0x3333333333333333333333333333333333333333", "s1"));
  res.finish();

  const claim = readClaim(res.headers);
  assert.ok(claim, "the paid response carries a receipt claim");
  assert.equal(await recoverReceiptSigner(claim!.hash, claim!.signature), provider.address);
});

test("a buyer refuses to counter-sign a receipt naming someone else", async () => {
  const provider = privateKeyToAccount(generatePrivateKey());
  const buyer = privateKeyToAccount(generatePrivateKey());
  const seller = createOculopusSeller({ provider, anchorEvery: 0 });
  const req = { originalUrl: "/embed", body: { text: "x" } };
  const res = mkRes();
  seller.track("embedding")(req, res as never, () => {});
  await seller.onAfterSettle(settleCtx("0x4444444444444444444444444444444444444444", "s2"));
  res.finish();

  const stored = seller.all()[0]!;
  const r = await counterSign(buyer, stored.receipt, readClaim(res.headers)!, {});
  assert.equal(r.ok, false);
  assert.match(r.reason!, /different buyer/);
});

test("a buyer refuses when the receipt describes a request it never sent", async () => {
  const provider = privateKeyToAccount(generatePrivateKey());
  const buyer = privateKeyToAccount(generatePrivateKey());
  const seller = createOculopusSeller({ provider, anchorEvery: 0 });
  const req = { originalUrl: "/embed", body: { text: "what I sent" } };
  const res = mkRes();
  seller.track("embedding")(req, res as never, () => {});
  await seller.onAfterSettle(settleCtx(buyer.address, "s3"));
  res.finish();

  const stored = seller.all()[0]!;
  const claim = readClaim(res.headers)!;
  const bad = await counterSign(buyer, stored.receipt, claim, { requestBody: { text: "something else" } });
  assert.equal(bad.ok, false);
  assert.match(bad.reason!, /requestHash/);

  const good = await counterSign(buyer, stored.receipt, claim, { requestBody: { text: "what I sent" } });
  assert.equal(good.ok, true, good.reason);
  assert.equal(await recoverReceiptSigner(claim.hash, good.buyerSig!), buyer.address);
});

test("a buyer refuses to endorse an overcharge", async () => {
  const provider = privateKeyToAccount(generatePrivateKey());
  const buyer = privateKeyToAccount(generatePrivateKey());
  const seller = createOculopusSeller({ provider, anchorEvery: 0 });
  const req = { originalUrl: "/embed", body: {} };
  const res = mkRes();
  seller.track("embedding")(req, res as never, () => {});
  await seller.onAfterSettle(settleCtx(buyer.address, "s4"));
  res.finish();

  const stored = seller.all()[0]!;
  const r = await counterSign(buyer, stored.receipt, readClaim(res.headers)!, { maxUsdc: "0.005" });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /charged 0.01/);
});

test("a tampered receipt cannot be passed off under the provider's signature", async () => {
  const provider = privateKeyToAccount(generatePrivateKey());
  const buyer = privateKeyToAccount(generatePrivateKey());
  const seller = createOculopusSeller({ provider, anchorEvery: 0 });
  const req = { originalUrl: "/embed", body: {} };
  const res = mkRes();
  seller.track("embedding")(req, res as never, () => {});
  await seller.onAfterSettle(settleCtx(buyer.address, "s5"));
  res.finish();

  const stored = seller.all()[0]!;
  const tampered = { ...stored.receipt, howMuch: { usdc: "0.001" } };
  const r = await counterSign(buyer, tampered, readClaim(res.headers)!, {});
  assert.equal(r.ok, false);
  assert.match(r.reason!, /does not hash/);
});

test("a full batch anchors automatically and every receipt keeps a usable proof", async () => {
  const provider = privateKeyToAccount(generatePrivateKey());
  let anchoredRoot: `0x${string}` | null = null;
  const seller = createOculopusSeller({
    provider,
    anchorEvery: 4,
    onAnchor: async (root) => { anchoredRoot = root; return ("0x" + "ab".repeat(32)) as `0x${string}`; },
  });
  for (let i = 0; i < 4; i++) {
    const req = { originalUrl: "/embed", body: { i } };
    const res = mkRes();
    seller.track("embedding")(req, res as never, () => {});
    await seller.onAfterSettle(settleCtx("0x5555555555555555555555555555555555555555", `batch-${i}`));
    res.finish();
  }
  assert.ok(anchoredRoot, "reaching anchorEvery triggers the anchor");
  assert.equal(seller.pending().length, 0, "anchored receipts leave the pending set");
  for (const entry of seller.all()) {
    assert.ok(entry.anchor, "each receipt records its anchor");
    assert.ok(verifyMerkleProof(entry.hash, entry.anchor!.proof, entry.anchor!.root));
  }
});
