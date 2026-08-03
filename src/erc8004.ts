// ERC-8004 (Trustless Agents) — Arc Network's native agent identity + reputation
// registries. Addresses from docs.arc.io, then verified live on Arc testnet:
// IdentityRegistry is an ERC-1967 proxy answering name()="AgentIdentity",
// symbol()="AGENT", with real owners for agentIds 1/2/5/20.
//
// Why Oculopus builds ON this instead of beside it:
//   - Identity: agentId is an ERC-721 token. One global id, not our own registry.
//   - Reputation: the registry is an EVENT BUS, not a scoreboard. getSummary()
//     REVERTS with "clientAddresses required" when given an empty client list —
//     the standard deliberately refuses to decide what a score means, and cannot
//     aggregate without an off-chain indexer supplying the client set. That is
//     exactly the gap Oculopus fills.
//   - Trust: giveFeedback() is a single signature from the client. Nothing binds it
//     to a payment, and the agent being rated never signs. Oculopus's contribution
//     is requiring each feedback to point at a co-signed receipt anchored in the
//     payment itself (see receipt.ts / the Memo extension).
import { parseAbi } from "viem";

export const ERC8004 = {
  identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  validation: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
} as const;

export const identityAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

export const reputationAbi = parseAbi([
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "function getClients(uint256 agentId) view returns (address[])",
  "function getLastIndex(uint256 agentId, address clientAddress) view returns (uint64)",
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
  "function readAllFeedback(uint256 agentId, address[] clientAddresses, string tag1, string tag2, bool includeRevoked) view returns (address[] clients, uint64[] indexes, int128[] values, uint8[] valueDecimals, string[] tag1s, string[] tag2s, bool[] revoked)",
  // Taken from the VERIFIED implementation behind the proxy (Blockscout getabi on
  // 0x16e0fa7f…da34), not from the EIP text: the deployed event carries a
  // feedbackIndex and an extra `string indexed indexedTag1` that the spec prose
  // omits. Deriving the topic from the spec signature finds zero logs.
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
]);

export const validationAbi = parseAbi([
  "function getSummary(uint256 agentId, address[] validatorAddresses, string tag) view returns (uint64 count, uint8 averageResponse)",
  "function getAgentValidations(uint256 agentId) view returns (bytes32[] requestHashes)",
  "function getValidationStatus(bytes32 requestHash) view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string tag, uint256 lastUpdate)",
]);

/** One feedback entry as the registry stores it, normalised to a 0..1 rating. */
export interface Feedback {
  client: string;
  index: bigint;
  /** value / 10**valueDecimals, clamped to 0..1 — registries use varying scales. */
  rating: number;
  tag1: string;
  tag2: string;
  revoked: boolean;
}

/**
 * int128 value + decimals -> a 0..1 rating.
 *
 * ERC-8004 fixes the fixed-point encoding (value / 10**valueDecimals) but NOT the
 * range, so publishers disagree. Both of these are live on Arc testnet right now:
 *   agentId 1 -> value 92,  decimals 0 -> 92    (a 0..100 scale)
 *   agentId 2 -> value 91,  decimals 1 -> 9.1   (a 0..10 scale)
 * Both mean "about 9 out of 10". Reading either literally as a percentage gets one
 * of them badly wrong — 9.1 would look like a failing agent.
 *
 * So we infer the scale from the magnitude. It is a heuristic and it is wrong for a
 * genuine 0.9%-out-of-100 rating; no on-chain field distinguishes those cases.
 */
export function normaliseRating(value: bigint, valueDecimals: number): number {
  const v = Number(value) / 10 ** valueDecimals;
  if (v < 0) return 0;
  const scale = v <= 1 ? 1 : v <= 10 ? 10 : 100;
  return Math.min(1, v / scale);
}

/** The RPC caps eth_getLogs at 1000 blocks per request — confirmed live (-32005). */
export const MAX_LOG_SPAN = 1000n;
