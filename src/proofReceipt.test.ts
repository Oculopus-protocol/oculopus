// Unit tests for the Proof Receipt scaffold — commitment + selective disclosure.
// Fully offline. The ZK proof itself is out of scope here (roadmap); these lock in the
// commitment's hiding/binding and the public/private split the circuit will build on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { receiptHash, type Receipt, type SignedReceipt } from "./receipt.js";
import { scoreProvider } from "./scorer.js";
import {
  commit,
  opensTo,
  tierOf,
  split,
  buildProofReceipt,
  proofMemoId,
  toScoreRecord,
  counterpartyNullifier,
  type PrivateFields,
} from "./proofReceipt.js";

const buyer = privateKeyToAccount(("0x" + "11".repeat(32)) as Hex);
const provider = privateKeyToAccount(("0x" + "22".repeat(32)) as Hex);

const receipt: Receipt = {
  v: 1,
  who: { buyer: buyer.address, provider: provider.address },
  what: { service: "embed-v1", jobId: "job-0001" },
  where: { endpoint: "api.provider.xyz/embed" },
  when: { requestedAt: 1789000000000, deliveredAt: 1789000000412 },
  why: { taskRef: "research-batch-7" },
  how: { requestHash: ("0x" + "ab".repeat(32)) as Hex, responseHash: ("0x" + "cd".repeat(32)) as Hex },
  howMuch: { usdc: "0.12" },
  effect: { outcome: "success", latencyMs: 412 },
  risk: { dispute: false },
};
const signed: SignedReceipt = { receipt, sigs: {} };
const SALT = ("0x" + "99".repeat(32)) as Hex;
const opts = { rail: "onchain", agentId: "1", serviceTag: 1, salt: SALT } as const;

test("commitment is deterministic and hiding (salt matters)", () => {
  const { private: priv } = split(signed, opts);
  assert.equal(commit(priv), commit(priv));
  const priv2: PrivateFields = { ...priv, salt: ("0x" + "88".repeat(32)) as Hex };
  assert.notEqual(commit(priv2), commit(priv));
});

test("commitment binds: only the true opening reproduces it", () => {
  const { private: priv } = split(signed, opts);
  const c = commit(priv);
  assert.ok(opensTo(priv, c));
  assert.ok(!opensTo({ ...priv, usdc: "9.99" }, c));
  assert.ok(!opensTo({ ...priv, buyer: provider.address }, c));
});

test("private mode publishes no receipt; memoId = commitment", () => {
  const { proofReceipt } = buildProofReceipt({ signed, mode: "private", rail: "onchain", agentId: "1", serviceTag: 1, bothSigned: true, salt: SALT });
  assert.equal(proofReceipt.signed, undefined);
  assert.equal(proofMemoId(proofReceipt), proofReceipt.commitment);
  assert.equal(proofReceipt.public.outcome, "success");
  assert.equal(proofReceipt.claims.amountTier, tierOf("0.12"));
});

test("public mode is unchanged: full receipt, memoId = receiptHash", () => {
  const { proofReceipt } = buildProofReceipt({ signed, mode: "public", rail: "onchain", agentId: "1", serviceTag: 1, bothSigned: true, salt: SALT });
  assert.ok(proofReceipt.signed);
  assert.equal(proofMemoId(proofReceipt), receiptHash(receipt));
});

test("amount tiers bucket the payment without revealing it", () => {
  assert.equal(tierOf("0"), 0);
  assert.equal(tierOf("0.005"), 0);
  assert.equal(tierOf("0.01"), 1);
  assert.equal(tierOf("0.5"), 2);
  assert.equal(tierOf("3"), 3);
  assert.equal(tierOf("50"), 4);
});

test("nullifier is stable per counterparty, distinct across counterparties", () => {
  const n = counterpartyNullifier(buyer.address, provider.address);
  assert.equal(n, counterpartyNullifier(buyer.address, provider.address));
  const other = privateKeyToAccount(("0x" + "55".repeat(32)) as Hex);
  assert.notEqual(counterpartyNullifier(other.address, provider.address), n);
});

test("a private receipt scores through the open scorer — from claims, not data", () => {
  const { proofReceipt } = buildProofReceipt({ signed, mode: "private", rail: "onchain", agentId: "1", serviceTag: 1, bothSigned: true, salt: SALT });
  const rec = toScoreRecord(proofReceipt);
  // the record the scorer sees carries NO real buyer and NO exact amount
  assert.notEqual(rec.buyer.toLowerCase(), buyer.address.toLowerCase());
  assert.equal(rec.buyer, proofReceipt.claims.counterpartyNullifier);
  assert.notEqual(rec.usdc, "0.12");
  assert.equal(rec.tier, "receipt");
  // yet it still earns a real score, and the per-counterparty cap still has a key to bucket by
  const s = scoreProvider([rec], receipt.when.deliveredAt);
  assert.ok(s.score > 25);
  assert.equal(s.uniqueCounterparties, 1);
});
