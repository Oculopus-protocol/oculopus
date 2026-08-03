// The Oculopus agent-card scheme.
//
// ERC-8004 gives an agent a global on-chain identity (agentId, owner) and a tokenURI
// that points at an off-chain "agent card". The registry standardises the IDENTITY;
// it says nothing about what the card CONTAINS. Every reader — Oculopus, another
// agent, the explore view, a future marketplace — then has to guess the shape.
//
// This module is that missing shape: one JSON schema for the card at the tokenURI, so
// a card can be filtered, validated and relied on. It is deliberately a schema layered
// ON TOP OF ERC-8004, not a competing registry — Oculopus deploys no identity contract
// of its own.
//
// Pure and chain-free on purpose: the same validator runs in the node, in a register
// script, and in the browser register form. It validates SHAPE only. It does NOT prove
// the card is genuine — that the claimed agentId is really owned by `owner`, and that
// the identity's tokenURI really resolves to this card, is an ON-CHAIN check the node
// does separately (ownerOf + tokenURI). A valid shape with a lying `owner` is still a
// lie; see bindingCheckHints below.
import { categoryBySlug, categoryByTag } from "./categories.js";

export const CARD_SCHEME = "oculopus-agent-card";
export const CARD_VERSION = 1;

export interface OculopusAgentCard {
  /** Scheme marker + version, so a reader can tell this is a conformant card. */
  scheme: typeof CARD_SCHEME;
  v: number;
  /** The ERC-8004 agentId this card claims. Must be cross-checked on-chain. */
  agentId: string;
  /** Wallet that must own `agentId`. Cross-checkable: ownerOf(agentId) == owner. */
  owner: string;
  name: string;
  /** Base HTTP(S) endpoint the agent serves from. */
  endpoint: string;
  /** Category slug from categories.ts — what the agent sells. */
  service: string;
  /** On-chain serviceTag; must agree with `service` when both are present. */
  serviceTag: number;
  /** Capabilities the agent exposes, e.g. ["transfer","swap","balance"]. */
  skills: string[];
  description?: string;
  /** Does the agent take Circle x402 payments, and a rough price hint. */
  x402?: { enabled: boolean; priceHint?: string };
  /** Explicit opt-ins. Gateway routing is opt-in, not assumed. */
  optIn?: { gateway?: boolean };
  /** Unix ms the card was last built. */
  updatedAt: number;
}

const isAddress = (s: unknown): s is string => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
const isHttpUrl = (s: unknown): boolean => typeof s === "string" && /^https?:\/\/.+/.test(s);
const isDigits = (s: unknown): boolean => typeof s === "string" && /^[0-9]+$/.test(s);

export interface CardValidation {
  valid: boolean;
  errors: string[];
  card?: OculopusAgentCard;
}

/**
 * Validate the SHAPE of an agent card against the Oculopus scheme.
 *
 * Returns every reason it failed, not just the first — a register form should be able
 * to show all the fixes at once. `card` is only set when valid.
 */
export function validateAgentCard(input: unknown): CardValidation {
  const errors: string[] = [];
  const c = input as Record<string, unknown>;
  if (typeof input !== "object" || input === null) return { valid: false, errors: ["card must be a JSON object"] };

  if (c.scheme !== CARD_SCHEME) errors.push(`scheme must be "${CARD_SCHEME}"`);
  if (c.v !== CARD_VERSION) errors.push(`v must be ${CARD_VERSION}`);
  if (!isDigits(c.agentId)) errors.push("agentId must be a decimal string (the ERC-8004 id)");
  if (!isAddress(c.owner)) errors.push("owner must be a 0x-address");
  if (typeof c.name !== "string" || !c.name.trim()) errors.push("name is required");
  if (!isHttpUrl(c.endpoint)) errors.push("endpoint must be an http(s) URL");

  const cat = typeof c.service === "string" ? categoryBySlug(c.service) : undefined;
  if (!cat) errors.push("service must be a known category slug (see categories.ts)");
  if (typeof c.serviceTag !== "number") {
    errors.push("serviceTag must be a number");
  } else if (cat && c.serviceTag !== cat.tag) {
    errors.push(`serviceTag ${c.serviceTag} does not match service "${c.service}" (tag ${cat.tag})`);
  } else if (!cat && !categoryByTag(c.serviceTag)) {
    errors.push(`serviceTag ${c.serviceTag} is not a known category`);
  }

  if (!Array.isArray(c.skills) || !c.skills.every((s) => typeof s === "string")) {
    errors.push("skills must be an array of strings");
  }
  if (c.description !== undefined && typeof c.description !== "string") errors.push("description must be a string");
  if (c.x402 !== undefined) {
    const x = c.x402 as Record<string, unknown>;
    if (typeof x !== "object" || x === null || typeof x.enabled !== "boolean") {
      errors.push("x402 must be { enabled: boolean, priceHint?: string }");
    } else if (x.priceHint !== undefined && typeof x.priceHint !== "string") {
      errors.push("x402.priceHint must be a string");
    }
  }
  if (c.optIn !== undefined) {
    const o = c.optIn as Record<string, unknown>;
    if (typeof o !== "object" || o === null) errors.push("optIn must be an object");
    else if (o.gateway !== undefined && typeof o.gateway !== "boolean") errors.push("optIn.gateway must be a boolean");
  }
  if (typeof c.updatedAt !== "number" || !Number.isFinite(c.updatedAt)) errors.push("updatedAt must be a unix-ms number");

  return errors.length ? { valid: false, errors } : { valid: true, errors: [], card: input as OculopusAgentCard };
}

/**
 * Build a conformant card from the fields an operator supplies. Fills scheme, version
 * and updatedAt, then validates — so it either returns a card that passes
 * validateAgentCard or throws saying why. Callers never hand-assemble the object.
 */
export function buildAgentCard(
  fields: Omit<OculopusAgentCard, "scheme" | "v" | "updatedAt" | "serviceTag"> & { serviceTag?: number },
): OculopusAgentCard {
  const cat = categoryBySlug(fields.service);
  const card = {
    ...fields,
    scheme: CARD_SCHEME,
    v: CARD_VERSION,
    serviceTag: fields.serviceTag ?? cat?.tag ?? -1,
    updatedAt: Date.now(),
  } as OculopusAgentCard;
  const check = validateAgentCard(card);
  if (!check.valid) throw new Error(`cannot build a conformant card: ${check.errors.join("; ")}`);
  return card;
}

/**
 * What still has to be verified ON-CHAIN before trusting a shape-valid card. Shape
 * validation alone lets anyone publish a card naming any owner and any agentId; only
 * these two checks tie the card to a real identity. The node runs them (ownerOf +
 * tokenURI); documented here so no reader forgets the schema does not do it.
 */
export const bindingCheckHints = [
  "ownerOf(card.agentId) == card.owner",
  "tokenURI(card.agentId) resolves to this exact card",
] as const;
