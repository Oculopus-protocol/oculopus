// Dashboard account API for the paid oracle: sign in with a wallet (SIWE-style nonce +
// personal_sign), then create / list / revoke API keys owned by that wallet. Mounted under
// /oracle/account/* so it reuses the oracle's nginx route; these routes are NOT x402-gated.
//
// Auth is a plain HMAC session token (no extra deps): sign-in returns a token the dashboard
// sends as `Authorization: Bearer …`. Set ORACLE_SESSION_SECRET to keep tokens valid across
// restarts (otherwise a random per-boot secret is used).
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { recoverMessageAddress, type Hex } from "viem";
import { createHmac, randomBytes } from "node:crypto";
import { keysOf, mintKeyFor, revokeKey } from "./oracleKeys.js";

const SECRET = process.env.ORACLE_SESSION_SECRET ?? randomBytes(32).toString("hex");
const TOKEN_TTL_MS = 7 * 86_400_000;
const NONCE_TTL_MS = 5 * 60_000;
const nonces = new Map<string, number>(); // nonce -> expiry
const message = (nonce: string): string => `Sign in to Oculopus\n\nNonce: ${nonce}`;

function signToken(address: string): string {
  const body = Buffer.from(JSON.stringify({ address, exp: Date.now() + TOKEN_TTL_MS })).toString("base64url");
  return body + "." + createHmac("sha256", SECRET).update(body).digest("base64url");
}
function readToken(token: string): { address: string; exp: number } | null {
  const [body, mac] = token.split(".");
  if (!body || !mac || createHmac("sha256", SECRET).update(body).digest("base64url") !== mac) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as { address: string; exp: number };
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
function auth(req: Request, res: Response, next: NextFunction): void {
  const p = readToken((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  if (!p) { res.status(401).json({ error: "sign in first" }); return; }
  (req as Request & { owner: string }).owner = p.address;
  next();
}

export function mountAccount(app: Express): void {
  // 1. Ask for a nonce to sign.
  app.get("/oracle/account/nonce", (_req, res) => {
    const nonce = randomBytes(16).toString("hex");
    nonces.set(nonce, Date.now() + NONCE_TTL_MS);
    res.json({ nonce, message: message(nonce) });
  });

  // 2. Verify the signature over the nonce → session token bound to the wallet.
  app.post("/oracle/account/verify", express.json(), async (req, res) => {
    const { address, signature, nonce } = (req.body ?? {}) as { address?: string; signature?: Hex; nonce?: string };
    const exp = nonce ? nonces.get(nonce) : undefined;
    if (!nonce || !exp || exp < Date.now()) { res.status(400).json({ error: "nonce missing or expired — request a fresh one" }); return; }
    nonces.delete(nonce); // one-time
    if (!address || !signature) { res.status(400).json({ error: "address and signature required" }); return; }
    let signer: string;
    try { signer = await recoverMessageAddress({ message: message(nonce), signature }); } catch { res.status(401).json({ error: "bad signature" }); return; }
    if (signer.toLowerCase() !== address.toLowerCase()) { res.status(401).json({ error: "signature does not match address" }); return; }
    res.json({ token: signToken(signer.toLowerCase()), address: signer.toLowerCase() });
  });

  // 3. Owner-scoped key management.
  app.get("/oracle/account/keys", auth, (req, res) => {
    res.json({ keys: keysOf((req as Request & { owner: string }).owner) });
  });
  app.post("/oracle/account/keys", express.json(), auth, (req, res) => {
    const label = String((req.body as { label?: string })?.label ?? "key").slice(0, 40) || "key";
    res.json({ key: mintKeyFor((req as Request & { owner: string }).owner, label), label });
  });
  app.delete("/oracle/account/keys/:key", auth, (req, res) => {
    res.json({ revoked: revokeKey((req as Request & { owner: string }).owner, String(req.params.key)) });
  });
}
