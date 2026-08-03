// Live verification of the Oculopus receipt rail on Arc Testnet.
//
// Proves, with one real transaction, every property the protocol depends on:
//   1. Memo.memo(USDC, transferCalldata, memoId, memoData) executes the USDC
//      transfer with msg.sender preserved (buyer's balance moves, not the wrapper's).
//   2. The Memo event carries our payloadHash as an INDEXED topic (memoId) — so an
//      indexer can filter receipts by hash without scanning calldata.
//   3. callDataHash in the event binds the memo to the exact transfer (to + amount).
//   4. eth_getLogs by memoId finds the receipt again — the exact indexer read path.
//
// Run: npm run verify:memo   (sends 0.01 testnet USDC buyer → recipient)
import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  http,
  fallback,
  encodeFunctionData,
  keccak256,
  toHex,
  concatHex,
  parseEventLogs,
  formatUnits,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, CHAIN_ID, CONTRACTS, USDC_DECIMALS, RPC_URLS } from "./config.js";
import { memoAbi, erc20Abi } from "./abi.js";

const pk = process.env.BUYER_PRIVATE_KEY as Hex | undefined;
const recipient = process.env.RECIPIENT as Hex | undefined;
if (!pk || !recipient) throw new Error("BUYER_PRIVATE_KEY / RECIPIENT missing in .env");

// Fallback across both public RPCs + generous retry — the official one rate-limits bursts.
const transport = () => fallback(RPC_URLS.map((u) => http(u, { retryCount: 4, retryDelay: 1500 })));
const buyer = privateKeyToAccount(pk);
const pub = createPublicClient({ chain: arcTestnet, transport: transport() });
const wallet = createWalletClient({ account: buyer, chain: arcTestnet, transport: transport() });

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---- 0. chain guard + balances before -------------------------------------------
const chainId = await pub.getChainId();
if (chainId !== CHAIN_ID) throw new Error(`RPC chainId ${chainId} != ${CHAIN_ID} — refusing to send`);
console.log(`Arc Testnet (${chainId})  buyer=${buyer.address}\n`);

// Sequential reads (not Promise.all) — the official RPC rate-limits bursts.
const bal = (addr: Hex) => pub.readContract({ address: CONTRACTS.usdc, abi: erc20Abi, functionName: "balanceOf", args: [addr] });
const buyerBefore = await bal(buyer.address);
const recvBefore = await bal(recipient);
console.log(`before  buyer=${formatUnits(buyerBefore, USDC_DECIMALS)}  recipient=${formatUnits(recvBefore, USDC_DECIMALS)}\n`);

// ---- 1. build a receipt exactly the way the protocol will -----------------------
// Off-chain receipt JSON (5W2H1E1R). For the spike its content is a stand-in; its
// HASH is what goes on-chain, which is the real mechanism under test.
const receiptJson = JSON.stringify({
  v: 1,
  who: { buyer: buyer.address, provider: recipient },
  what: { service: "spike-verify", jobId: "job-0001" },
  when: { deliveredAt: Date.now() },
  effect: { outcome: "success", latencyMs: 1 },
});
const payloadHash = keccak256(toHex(receiptJson)); // = memoId (indexed topic)

// Compact on-chain memoData blob: OCU1 | kind=1 receipt | outcome=1 success |
// serviceTag=0x0001 | jobId = first 4 bytes of payloadHash. 12 bytes total.
const memoData = concatHex(["0x4f435531", "0x01", "0x01", "0x0001", payloadHash.slice(0, 10) as Hex]);

const amount = 10_000n; // 0.01 USDC (6 decimals)
const innerCall = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, amount] });

// ---- 2. send the memo-wrapped transfer ------------------------------------------
const hash = await wallet.writeContract({
  address: CONTRACTS.memo,
  abi: memoAbi,
  functionName: "memo",
  args: [CONTRACTS.usdc, innerCall, payloadHash, memoData],
});
console.log(`tx ${hash}`);
const receipt = await pub.waitForTransactionReceipt({ hash });
check("tx mined successfully", receipt.status === "success", `block ${receipt.blockNumber}`);

// ---- 3. verify every event property the protocol depends on ---------------------
const memoEvents = parseEventLogs({ abi: memoAbi, eventName: "Memo", logs: receipt.logs });
check("Memo event emitted", memoEvents.length === 1);
const ev = memoEvents[0];
if (ev) {
  check("event.sender = buyer (msg.sender preserved)", ev.args.sender.toLowerCase() === buyer.address.toLowerCase());
  check("event.target = USDC", ev.args.target.toLowerCase() === CONTRACTS.usdc.toLowerCase());
  check("event.memoId = payloadHash (indexed)", ev.args.memoId === payloadHash);
  check("event.callDataHash binds the exact transfer", ev.args.callDataHash === keccak256(innerCall));
  check("event.memo = our compact OCU1 blob", ev.args.memo === memoData);
}

const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs });
const t = transfers.find((x) => x.address.toLowerCase() === CONTRACTS.usdc.toLowerCase());
check("USDC Transfer event present", !!t);
if (t) {
  check("transfer.from = buyer (not the Memo contract)", t.args.from.toLowerCase() === buyer.address.toLowerCase());
  check("transfer.to = recipient", t.args.to.toLowerCase() === recipient.toLowerCase());
  check("transfer.value = 0.01 USDC", t.args.value === amount);
}

// ---- 4. the indexer read path: find the receipt again by memoId ------------------
const found = await pub.getLogs({
  address: CONTRACTS.memo,
  event: memoAbi[2],
  args: { memoId: payloadHash },
  fromBlock: receipt.blockNumber,
  toBlock: receipt.blockNumber,
});
check("eth_getLogs by memoId finds the receipt (indexer path)", found.length === 1);

// ---- 5. balances after -----------------------------------------------------------
const buyerAfter = await bal(buyer.address);
const recvAfter = await bal(recipient);
console.log(`\nafter   buyer=${formatUnits(buyerAfter, USDC_DECIMALS)}  recipient=${formatUnits(recvAfter, USDC_DECIMALS)}`);
check("recipient received exactly 0.01 USDC", recvAfter - recvBefore === amount);

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`explorer: https://testnet.arcscan.app/tx/${hash}`);
process.exit(fail ? 1 : 0);
