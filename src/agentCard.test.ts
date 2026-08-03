// Tests for the Oculopus agent-card scheme — the shape a card at an ERC-8004 tokenURI
// must have to be filtered and relied on. Shape only; on-chain ownership is checked by
// the node, not here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentCard, validateAgentCard, CARD_SCHEME, CARD_VERSION } from "./agentCard.js";

const good = {
  scheme: CARD_SCHEME,
  v: CARD_VERSION,
  agentId: "851356",
  owner: "0x9AeC413fF42858EaF080aF688b9a858396Af1174",
  name: "atlas-embed",
  endpoint: "https://atlas.example",
  service: "embedding",
  serviceTag: 1,
  skills: ["embed", "batch-embed"],
  x402: { enabled: true, priceHint: "$0.01" },
  optIn: { gateway: true },
  updatedAt: Date.now(),
};

test("a conformant card validates and is returned", () => {
  const r = validateAgentCard(good);
  assert.equal(r.valid, true, r.errors.join("; "));
  assert.equal(r.card?.agentId, "851356");
});

test("every missing/wrong field is reported, not just the first", () => {
  const r = validateAgentCard({ scheme: "wrong", v: 9, agentId: 851356, owner: "nope" });
  assert.equal(r.valid, false);
  // scheme, v, agentId(type), owner, name, endpoint, service, serviceTag, skills, updatedAt
  assert.ok(r.errors.length >= 8, `got ${r.errors.length}: ${r.errors.join("; ")}`);
  assert.ok(r.errors.some((e) => e.includes("scheme")));
  assert.ok(r.errors.some((e) => e.includes("owner")));
});

test("an unknown service slug is rejected", () => {
  const r = validateAgentCard({ ...good, service: "nonsense", serviceTag: 1 });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes("service")));
});

test("serviceTag must agree with the service slug", () => {
  // embedding is tag 1; claiming tag 2 (llm-inference) is a mismatch a reader would
  // otherwise mis-filter on.
  const r = validateAgentCard({ ...good, service: "embedding", serviceTag: 2 });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes("does not match")));
});

test("skills must be an array of strings", () => {
  assert.equal(validateAgentCard({ ...good, skills: "embed" }).valid, false);
  assert.equal(validateAgentCard({ ...good, skills: [1, 2] }).valid, false);
});

test("a bad x402 block is rejected but omitting it is fine", () => {
  assert.equal(validateAgentCard({ ...good, x402: { enabled: "yes" } }).valid, false);
  const { x402, ...noX402 } = good;
  assert.equal(validateAgentCard(noX402).valid, true);
});

test("buildAgentCard fills scheme/version/tag and returns something that validates", () => {
  const card = buildAgentCard({
    agentId: "712004",
    owner: "0x2f81ba0d7cc4e9a5301bb6f2a7e4419c8d0a5b3e",
    name: "orion-rerank",
    endpoint: "https://orion.example",
    service: "rerank",
    skills: ["rerank"],
  });
  assert.equal(card.scheme, CARD_SCHEME);
  assert.equal(card.v, CARD_VERSION);
  assert.equal(card.serviceTag, 3); // rerank
  assert.equal(validateAgentCard(card).valid, true);
});

test("buildAgentCard throws on an unknown service rather than emitting a bad card", () => {
  assert.throws(
    () => buildAgentCard({ agentId: "1", owner: "0x" + "1".repeat(40), name: "x", endpoint: "https://x.example", service: "nope", skills: [] }),
    /cannot build a conformant card/,
  );
});
