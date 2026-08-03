// ERC-8183 — Arc's job lifecycle standard, read as tier-1 evidence.
//
// A completed ERC-8183 job is STRONGER evidence than an Oculopus receipt, and
// pretending otherwise would be dishonest:
//
//   - escrow is funded BEFORE the work, so the money was committed, not promised
//   - agreement is chain state, not a signature we happen to hold off-chain
//   - an evaluator accepts or rejects, which reaches the quality question that a
//     responseHash never can
//
// Our own receipt still exists because 8183 costs approve + createJob + fund +
// submit + complete — roughly five transactions. That is absurd overhead for a
// $0.002 API call. The two standards serve different job sizes, so Oculopus reads
// both and weighs them differently.
//
// We only READ these events. Oculopus does not implement escrow.
import { parseAbi } from "viem";

export const ERC8183 = {
  job: "0x0747EEf0706327138c69792bF28Cd525089e4583", // proxy; impl 0xa316fd02…351a
} as const;

export const jobAbi = parseAbi([
  "event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook)",
  "event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount)",
  "event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason)",
  "event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason)",
  // getJob returns ONE struct, not a flat tuple — the sibling `jobs(uint256)` getter
  // returns the same fields flattened. Declaring getJob flat silently shifts every
  // field by one and the evaluator address lands in `budget`.
  "struct JobView { uint256 id; address client; address provider; address evaluator; string description; uint256 budget; uint256 expiredAt; uint8 status; address hook; }",
  "function getJob(uint256 jobId) view returns (JobView job)",
]);

export interface Job {
  id: bigint;
  client: string;
  provider: string;
  evaluator: string;
  budget: bigint;
  status: number;
}

/**
 * Was the job judged by someone other than the party paying for it?
 *
 * ERC-8183 lets the client name itself as evaluator, which is convenient and also
 * means the acceptance is just the buyer's own opinion again. A genuinely third-party
 * evaluator is much harder to collude with, so the two cases cannot weigh the same.
 */
export function hasIndependentEvaluator(job: { client: string; evaluator: string }): boolean {
  return job.evaluator.toLowerCase() !== job.client.toLowerCase();
}
