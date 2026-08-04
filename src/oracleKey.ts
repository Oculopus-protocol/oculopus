// Mint an oracle API key (free-tier access up to the monthly quota).
//
//   npm run key:create -- "acme-app"
//
// Shown once — store it. Callers send it as `x-api-key:` (or `Authorization: Bearer …`)
// to read the oracle free within quota; keyless callers pay per call via x402.
import "dotenv/config";
import { mintKey } from "./oracleKeys.js";

const label = process.argv[2] ?? "default";
const limit = Number(process.env.ORACLE_FREE_LIMIT ?? 10000);
console.log(`\nAPI key (save now — shown once):\n  ${mintKey(label, limit)}\n  label: ${label} · free reads/month: ${limit}\n`);
