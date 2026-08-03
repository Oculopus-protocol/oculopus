// A provider agent: sells a deterministic mock service ("checksum embedding") for
// USDC, and countersigns receipts for jobs it actually served. Deliberately
// degradable at runtime — the demo flips one provider to failing mid-run and the
// buyer's reputation-driven selection routes away from it.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { keccak256, toHex, type Account, type Hex } from "viem";
import { canonicalize, signReceipt, receiptHash, type Receipt } from "../receipt.js";

export interface ProviderOptions {
  port: number;
  account: Account;
  priceUsdc: string; // quoted price per job, decimal string
}

export interface ProviderHandle {
  address: Hex;
  endpoint: string;
  degrade: () => void;
  heal: () => void;
  close: () => void;
}

// Deterministic mock work: 8-dim "embedding" derived from the input hash. Cheap,
// reproducible, and wrong-able (a degraded provider simply errors out).
export function checksumEmbed(input: string): number[] {
  const h = keccak256(toHex(input)).slice(2);
  return Array.from({ length: 8 }, (_, i) => parseInt(h.slice(i * 8, i * 8 + 8), 16) / 0xffffffff);
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || "{}");
}

export function startProvider(opts: ProviderOptions): ProviderHandle {
  const { port, account, priceUsdc } = opts;
  let degraded = false;
  // jobId → responseHash of what we actually served; countersigning checks against
  // this so we never sign a receipt for work we didn't do (or did differently).
  const served = new Map<string, Hex>();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "POST" && url.pathname === "/job") {
        const { jobId, input } = (await readBody(req)) as { jobId: string; input: string };
        if (degraded) return json(res, 500, { error: "internal error" }); // the failure mode
        const started = Date.now();
        const output = checksumEmbed(input);
        const responseHash = keccak256(toHex(canonicalize(output)));
        served.set(jobId, responseHash);
        return json(res, 200, {
          output,
          responseHash,
          deliveredAt: Date.now(),
          latencyMs: Date.now() - started,
          priceUsdc,
          provider: account.address,
        });
      }

      if (req.method === "POST" && url.pathname === "/countersign") {
        const { receipt } = (await readBody(req)) as { receipt: Receipt };
        // Sign only what we can attest: it's us, we served exactly this response for
        // this job, the outcome claims success, and the price is our quote.
        if (receipt.who.provider.toLowerCase() !== account.address.toLowerCase())
          return json(res, 400, { error: "not my receipt" });
        if (receipt.effect.outcome !== "success") return json(res, 400, { error: "will not countersign a non-success claim" });
        if (served.get(receipt.what.jobId) !== receipt.how.responseHash)
          return json(res, 400, { error: "response hash does not match what I served" });
        if (receipt.howMuch.usdc !== priceUsdc) return json(res, 400, { error: "wrong price" });
        const sig = await signReceipt(receipt, account);
        return json(res, 200, { sig, hash: receiptHash(receipt) });
      }

      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 400, { error: (e as Error).message });
    }
  });

  server.listen(port, "127.0.0.1");
  return {
    address: account.address as Hex,
    endpoint: `http://127.0.0.1:${port}`,
    degrade: () => (degraded = true),
    heal: () => (degraded = false),
    close: () => server.close(),
  };
}
