// Drop-in Oculopus for an x402 seller.
//
// A provider adds two lines to an existing Circle Gateway endpoint and every paid call
// starts producing a signed, anchorable receipt:
//
//   const oculopus = createOculopusSeller({ provider: account, agentId, anchorEvery: 25 });
//   gateway.onAfterSettle(oculopus.onAfterSettle);
//   app.post("/embed", oculopus.track("embedding"), gateway.require("$0.01"), handler);
//
// ORDER MATTERS. `track()` must run BEFORE `gateway.require()`: the Gateway middleware
// settles the payment inline, so `onAfterSettle` fires while `require()` is still
// running. Put `track()` second and the settle hook finds no slot, producing a receipt
// with service "unknown", an empty endpoint, and the hash of an empty body — which a
// buyer then correctly refuses to counter-sign. Seen live before the order was fixed.
//
// Nothing here holds a buyer key, relays a payment, or sits in the money path. The
// seller signs its own receipts; the buyer counter-signs later, out of band.
import { keccak256, toHex, type Account, type Address, type Hex } from "viem";
import { canonicalize } from "./receipt.js";
import {
  buildX402Receipt,
  merkleProof,
  merkleRoot,
  x402ReceiptHash,
  type BuildArgs,
  type SettleContextLike,
  type X402Receipt,
} from "./x402.js";

/** Header the provider's receipt hash and signature travel back on. */
export const RECEIPT_HEADER = "x-oculopus-receipt";
export const SIGNATURE_HEADER = "x-oculopus-signature";

export interface StoredX402Receipt {
  receipt: X402Receipt;
  hash: Hex;
  /** Provider's EIP-712 signature. The buyer adds theirs when it counter-signs. */
  providerSig: Hex;
  buyerSig?: Hex;
  /** Set once the batch containing this receipt is anchored. */
  anchor?: { root: Hex; tx: Hex; proof: Hex[] };
}

export interface SellerConfig {
  /** The provider's own signing account. Only ever signs its own receipts. */
  provider: Account;
  /** Provider's ERC-8004 agentId, so readers can tie receipts to a registered identity. */
  agentId?: string;
  /** Anchor once this many receipts are pending. 0 disables automatic anchoring. */
  anchorEvery?: number;
  /** Called when a batch is ready. Return the anchoring transaction hash. */
  onAnchor?: (root: Hex, hashes: Hex[]) => Promise<Hex>;
}

/**
 * Minimal Express-shaped request/response. Typed structurally so this module does not
 * drag in an Express dependency for sellers who use something else.
 */
interface Req {
  method?: string;
  originalUrl?: string;
  url?: string;
  body?: unknown;
}
interface Res {
  statusCode?: number;
  headersSent?: boolean;
  setHeader?: (name: string, value: string) => void;
  writeHead?: (...args: never[]) => unknown;
  on?: (event: string, cb: () => void) => void;
}

export interface OculopusSeller {
  /** Hand this to `gateway.onAfterSettle`. */
  onAfterSettle: (ctx: SettleContextLike) => Promise<void>;
  /**
   * The receipt for a given settlement id.
   *
   * Circle's `GatewayClient.pay()` returns `{ data, amount, transaction, status }` and
   * **no response headers**, so a buyer cannot read the claim off the response — the
   * headers are still set for HTTP clients that do expose them, but this lookup is what
   * an x402 buyer actually uses. `transaction` is the settlement id, which is exactly
   * the key the receipt already carries.
   */
  bySettlement: (settlementId: string) => StoredX402Receipt | undefined;
  /** Express middleware; pass the service category for this route. */
  track: (service: string) => (req: Req, res: Res, next: () => void) => void;
  /** Receipts not yet anchored. */
  pending: () => StoredX402Receipt[];
  /** Every receipt this seller has produced, newest last. */
  all: () => StoredX402Receipt[];
  /** Anchor everything pending now, regardless of anchorEvery. */
  flush: () => Promise<Hex | null>;
  /** Record a buyer's counter-signature against a receipt hash. */
  counterSign: (hash: Hex, buyerSig: Hex) => boolean;
}

export function createOculopusSeller(config: SellerConfig): OculopusSeller {
  const { provider, anchorEvery = 25 } = config;
  const store = new Map<Hex, StoredX402Receipt>();
  let pendingHashes: Hex[] = [];

  // The settle hook fires during a request but is handed no request object, so the
  // route and body have to be matched to it some other way.
  //
  // A single `currentReq` variable does NOT work: two concurrent buyers interleave, the
  // second overwrites it before the first settles, and both receipts end up with the
  // same request hash while each response returns the other's receipt. Verified against
  // this exact code — A and B produced identical hashes.
  //
  // Instead each request pushes its own slot onto a FIFO and settle claims the oldest
  // unclaimed one. Settlement happens in request order within a process, so the oldest
  // pending slot is the one being settled.
  interface Slot { service: string; requestedAt: number; requestHash: Hex; endpoint: string; hash?: Hex; claimed: boolean }
  const slots: Slot[] = [];
  const slotOf = new WeakMap<Req, Slot>();

  async function onAfterSettle(ctx: SettleContextLike): Promise<void> {
    const meta = slots.find((s) => !s.claimed);
    if (!meta) {
      // No slot means track() did not run first — see the ordering note at the top.
      // Building a receipt anyway yields one nobody can counter-sign, which is worse
      // than none, so say so instead.
      console.warn(
        "[oculopus] settle with no tracked request: put oculopus.track() BEFORE gateway.require()",
      );
      return;
    }
    meta.claimed = true;
    const args: BuildArgs = {
      provider: provider.address as Address,
      service: meta.service,
      jobId: ctx.result.transaction,
      endpoint: meta.endpoint,
      requestedAt: meta.requestedAt,
      requestHash: meta.requestHash,
      // The handler has not run yet at settle time, so the response is not hashable
      // here. Filled in by track()'s finish callback, which recomputes the hash.
      responseHash: keccak256(toHex("")),
      outcome: "success",
    };
    const receipt = buildX402Receipt(ctx, args);
    const hash = x402ReceiptHash(receipt);
    if (!provider.signTypedData) throw new Error("provider account cannot sign typed data");
    const providerSig = await provider.signTypedData({
      domain: { name: "Oculopus Receipt", version: "1", chainId: 5042002 },
      types: { X402Receipt: [{ name: "receiptHash", type: "bytes32" }] },
      primaryType: "X402Receipt",
      message: { receiptHash: hash },
    });
    store.set(hash, { receipt, hash, providerSig });
    meta.hash = hash; // so this request's response returns THIS receipt
    pendingHashes.push(hash);
    if (anchorEvery > 0 && pendingHashes.length >= anchorEvery) await flush();
  }

  function track(service: string) {
    return (req: Req, res: Res, next: () => void): void => {
      const slot: Slot = {
        service,
        requestedAt: Date.now(),
        requestHash: keccak256(toHex(canonicalize(req.body ?? {}))),
        endpoint: req.originalUrl ?? req.url ?? "",
        claimed: false,
      };
      slots.push(slot);
      slotOf.set(req, slot);
      // Attach the claim by wrapping writeHead, which runs while headers are still
      // mutable. The obvious `res.on("finish")` is too late — that fires after the
      // response has been flushed, so setHeader throws ERR_HTTP_HEADERS_SENT and takes
      // the server down with it. Seen live.
      //
      // Headers only reach clients that expose them; Circle's GatewayClient.pay() does
      // not, which is why bySettlement() exists.
      const attach = (): void => {
        const mine = slotOf.get(req);
        const entry = mine?.hash ? store.get(mine.hash) : undefined;
        if (entry && res.setHeader && !res.headersSent) {
          res.setHeader(RECEIPT_HEADER, entry.hash);
          res.setHeader(SIGNATURE_HEADER, entry.providerSig);
        }
      };
      const release = (): void => {
        const i = slots.indexOf(slot);
        if (i !== -1) slots.splice(i, 1);
      };
      if (typeof res.writeHead === "function") {
        const original = res.writeHead.bind(res);
        res.writeHead = ((...a: unknown[]) => {
          attach();
          return (original as (...x: unknown[]) => unknown)(...a);
        }) as typeof res.writeHead;
      }
      res.on?.("finish", release);
      res.on?.("close", release);
      next();
    };
  }

  async function flush(): Promise<Hex | null> {
    if (!pendingHashes.length || !config.onAnchor) return null;
    const batch = [...pendingHashes];
    const root = merkleRoot(batch);
    const tx = await config.onAnchor(root, batch);
    batch.forEach((h, i) => {
      const entry = store.get(h);
      if (entry) entry.anchor = { root, tx, proof: merkleProof(batch, i) };
    });
    pendingHashes = pendingHashes.filter((h) => !batch.includes(h));
    return tx;
  }

  return {
    onAfterSettle,
    bySettlement: (settlementId) =>
      [...store.values()].find((r) => r.receipt.settlementId === settlementId),
    track,
    pending: () => pendingHashes.map((h) => store.get(h)!).filter(Boolean),
    all: () => [...store.values()],
    flush,
    counterSign: (hash, buyerSig) => {
      const entry = store.get(hash);
      if (!entry) return false;
      entry.buyerSig = buyerSig;
      return true;
    },
  };
}
