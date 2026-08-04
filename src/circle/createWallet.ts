// One-time setup — create the Oculopus treasury: a wallet set + one EOA wallet on Arc Testnet.
// Run after `circle:register`. Prints the ids/address to copy into .env.
//
//   npm run circle:wallet
//
// EOA (no creation fee, receives immediately) is the right shape for a treasury/receive wallet.
// On Arc, gas IS USDC, so funding this address with testnet USDC covers everything.
// Fund it at https://faucet.circle.com.
import "dotenv/config";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const apiKey = process.env.CIRCLE_API_KEY;
const entitySecret = process.env.ENTITY_SECRET;
if (!apiKey || !entitySecret) throw new Error("Set CIRCLE_API_KEY and ENTITY_SECRET in .env first.");

const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

const set = await client.createWalletSet({ name: "Oculopus treasury" });
const walletSetId = set.data?.walletSet?.id;
if (!walletSetId) throw new Error("createWalletSet returned no id");

const created = await client.createWallets({
  accountType: "EOA",
  blockchains: ["ARC-TESTNET"],
  count: 1,
  walletSetId,
});
const wallet = created.data?.wallets?.[0];

console.log("\n→ Add these to .env:\n");
console.log("CIRCLE_WALLET_SET_ID=" + walletSetId);
console.log("OCULOPUS_TREASURY_WALLET_ID=" + (wallet?.id ?? ""));
console.log("OCULOPUS_TREASURY_ADDRESS=" + (wallet?.address ?? ""));
console.log("\nFund the address with testnet USDC: https://faucet.circle.com\n");
