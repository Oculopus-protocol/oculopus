// Unit tests for the receipt library — fully offline (local key signing only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import {
  canonicalize,
  receiptHash,
  signReceipt,
  verifySignedReceipt,
  encodeMemoData,
  decodeMemoData,
  MEMO_KIND,
  type Receipt,
} from "./receipt.js";

const buyer = privateKeyToAccount(("0x" + "11".repeat(32)) as Hex);
const provider = privateKeyToAccount(("0x" + "22".repeat(32)) as Hex);
const witness = privateKeyToAccount(("0x" + "33".repeat(32)) as Hex);
const stranger = privateKeyToAccount(("0x" + "44".repeat(32)) as Hex);

const base: Receipt = {
  v: 1,
  who: { buyer: buyer.address, provider: provider.address },
  what: { service: "embed-v1", jobId: "job-0001" },
  where: { endpoint: "api.provider.xyz/embed" },
  when: { requestedAt: 1789000000000, deliveredAt: 1789000000412 },
  why: { taskRef: "research-batch-7" },
  how: { requestHash: ("0x" + "aa".repeat(32)) as Hex, responseHash: ("0x" + "bb".repeat(32)) as Hex },
  howMuch: { usdc: "0.0008" },
  effect: { outcome: "success", latencyMs: 412 },
  risk: { dispute: false },
};

test("canonicalize is stable under key reordering", () => {
  const reordered = JSON.parse(JSON.stringify(base, ["risk", "effect", "howMuch", "how", "why", "when", "where", "what", "who", "v", "buyer", "provider", "service", "jobId", "endpoint", "requestedAt", "deliveredAt", "taskRef", "requestHash", "responseHash", "usdc", "outcome", "latencyMs", "dispute"])) as Receipt;
  assert.equal(canonicalize(reordered), canonicalize(base));
  assert.equal(receiptHash(reordered), receiptHash(base));
});

test("co-signed receipt verifies for both parties", async () => {
  const signed = {
    receipt: base,
    sigs: { buyer: await signReceipt(base, buyer), provider: await signReceipt(base, provider) },
  };
  const v = await verifySignedReceipt(signed);
  assert.equal(v.buyerSigned, true);
  assert.equal(v.providerSigned, true);
  assert.equal(v.witness, null);
  assert.equal(v.hash, receiptHash(base));
});

test("tampered content invalidates existing signatures", async () => {
  const sig = await signReceipt(base, buyer);
  const tampered: Receipt = { ...base, howMuch: { usdc: "999" } };
  const v = await verifySignedReceipt({ receipt: tampered, sigs: { buyer: sig } });
  assert.equal(v.buyerSigned, false);
});

test("a stranger's signature does not count as buyer or provider", async () => {
  const v = await verifySignedReceipt({
    receipt: base,
    sigs: { buyer: await signReceipt(base, stranger) },
  });
  assert.equal(v.buyerSigned, false);
});

test("witness signature recovers the witness address", async () => {
  const v = await verifySignedReceipt({
    receipt: base,
    sigs: { witness: await signReceipt(base, witness) },
  });
  assert.equal(v.witness?.toLowerCase(), witness.address.toLowerCase());
});

test("memoData blob roundtrips", () => {
  const hash = receiptHash(base);
  const blob = encodeMemoData({ kind: MEMO_KIND.receipt, outcome: "success", serviceTag: 7, receiptHash: hash });
  assert.equal(blob.length, 2 + 24); // 12 bytes
  const decoded = decodeMemoData(blob);
  assert.ok(decoded);
  assert.equal(decoded.kind, MEMO_KIND.receipt);
  assert.equal(decoded.outcome, "success");
  assert.equal(decoded.serviceTag, 7);
  assert.equal(decoded.jobIdHint, hash.slice(0, 10));
});

test("decodeMemoData rejects wrong magic and wrong length", () => {
  assert.equal(decodeMemoData(("0xdeadbeef" + "00".repeat(8)) as Hex), null);
  assert.equal(decodeMemoData("0x4f435531" as Hex), null);
});
