// One-time setup — register the entity secret ciphertext with Circle and write a recovery
// file OUTSIDE the repo. Run after `circle:gen`, with CIRCLE_API_KEY + ENTITY_SECRET in .env.
//
//   npm run circle:register
//
// The SDK encrypts ENTITY_SECRET with Circle's public key and registers it, so there is no
// need to paste anything into the Console. Store the recovery file safely — Circle cannot
// restore it for you.
import "dotenv/config";
import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { registerEntitySecretCiphertext } from "@circle-fin/developer-controlled-wallets";

const apiKey = process.env.CIRCLE_API_KEY;
const entitySecret = process.env.ENTITY_SECRET;
if (!apiKey || !entitySecret) throw new Error("Set CIRCLE_API_KEY and ENTITY_SECRET in .env first.");

// The SDK treats recoveryFileDownloadPath as a DIRECTORY and writes recovery_file_<uuid>.dat
// inside it — pass a directory that exists, not a file path.
const recoveryDir = path.join(os.homedir(), ".circle");
mkdirSync(recoveryDir, { recursive: true });

try {
  await registerEntitySecretCiphertext({ apiKey, entitySecret, recoveryFileDownloadPath: recoveryDir });
  console.log("\nRegistered. Recovery file saved under:", recoveryDir);
  console.log("→ Back it up privately (not in the repo). Then run `npm run circle:wallet`.\n");
} catch (e) {
  const msg = String((e as Error)?.message ?? e);
  // The entity secret may already be registered from an earlier run (Circle registers
  // before the local recovery file is written). That is fine — the secret in .env is the
  // thing to keep safe; the recovery file is only a secondary backup.
  if (/already|registered|exist/i.test(msg)) {
    console.log("\nEntity secret already registered with Circle — nothing more to do here.");
    console.log("(Make sure ENTITY_SECRET in .env is backed up privately.) Next: `npm run circle:wallet`.\n");
  } else {
    throw e;
  }
}
