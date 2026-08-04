// One-time setup — generate a 32-byte entity secret for Circle developer-controlled wallets.
//
//   npm run circle:gen
//
// Copy the printed ENTITY_SECRET line into .env (gitignored). Circle never stores it; lose it
// and you lose control of the wallets. Keep a private backup, then run `npm run circle:register`.
import { randomBytes } from "node:crypto";

console.log("\nENTITY_SECRET=" + randomBytes(32).toString("hex") + "\n");
console.log("→ Paste the line above into .env. Never commit it. Keep a private backup.\n");
