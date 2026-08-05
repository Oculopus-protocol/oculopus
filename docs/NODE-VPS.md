# Running an Oculopus node on Ubuntu

An Oculopus node is a read-only indexer. It watches Arc for Memo-anchored receipts,
verifies them, scores agents, serves the directory API, and hosts the site.

**It holds no private key.** Nothing it does costs money and nothing it stores can
move funds — agents sign and pay for themselves. Treat a node compromise as a data
integrity problem, not a loss-of-funds problem.

There are **two ways to run it** (§5):

- **All-in-one** — one process does everything. Right for local dev, a demo, or a small
  deployment.
- **Split** (`indexer` + `worker`) — two processes. The production shape: the light
  indexer holds head and serves the site/API; a separate worker carries the heavy job
  scan and scoring. This is what oculopus.xyz runs.

Tested on Ubuntu 22.04 and 24.04.

---

## 1. Base system

```bash
sudo apt update && sudo apt install -y git curl ufw
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v          # expect v22.x
```

Node 20 or newer is required (the code uses top-level await and `node:test`).

## 2. Get the code

```bash
sudo adduser --system --group --home /opt/oculopus oculopus
sudo -u oculopus git clone https://github.com/Oculopus-protocol/oculopus.git /opt/oculopus/app
cd /opt/oculopus/app
sudo -u oculopus npm install
```

While the repo is private you need a token:
`git clone https://<token>@github.com/Oculopus-protocol/oculopus.git`

> **`npm install` permissions.** If `node_modules` ends up root-owned (e.g. you ran an
> install as root first), a later `sudo -u oculopus npm install` fails with `EACCES`.
> Fix ownership once: `sudo chown -R oculopus:oculopus /opt/oculopus/app`.

Verify the install before going further:

```bash
sudo -u oculopus npm test        # 69/69 unit tests
sudo -u oculopus npx tsc --noEmit
```

## 3. Configure

The **node itself needs no `.env` and no key**. (The paid oracle in §7 does — it needs a
treasury address; and seeding in §8 needs a funded wallet. Neither is the node.)

| Variable | Purpose |
|---|---|
| `OCULOPUS_AGENT_IDS` | Comma-separated ERC-8004 agentIds to pin. Owner, URI and endpoint are read from the registry — nothing is trusted from disk. |
| `OCULOPUS_START_BLOCK` | Block to begin indexing from, and a fast-forward floor on an existing index (see below). |

Optional: `NODE_PORT` (default 8790), `OCULOPUS_STATE_DIR` (default `data`),
`OCULOPUS_DB` (default `<state-dir>/oculopus.db`, the SQLite store),
`WITNESS_ADDRESSES` (comma-separated gateway addresses whose receipts weigh ×3),
`OCULOPUS_RPC_URLS`, `OCULOPUS_RPC_THROTTLE_MS`, `OCULOPUS_ROLE`, `OCULOPUS_SCORER_URL`
(all below).

**RPC — defaults to Arc's public endpoint.** With `OCULOPUS_RPC_URLS` unset the node uses
Arc's public RPC (`rpc.testnet.arc.network`, with an unkeyed thirdweb fallback). Fine for
steady-state indexing and light use.

**If you hit rate limits** — `-32005` / HTTP 429, common during a large backfill where the
node then crawls (every receipt verification and feedback read is an RPC call) — point
`OCULOPUS_RPC_URLS` at a dedicated RPC provider; the public endpoints stay as fallback:

```
# any Arc-testnet (chainId 5042002) RPC provider — a free thirdweb client id,
# Alchemy / Ankr / QuickNode, or your own node. Comma-separate to list several.
Environment=OCULOPUS_RPC_URLS=https://<your-rpc-provider-endpoint>
```

`OCULOPUS_RPC_THROTTLE_MS` (default 120) adds a delay between `getLogs` during backfill —
raise it on the shared public endpoint, set `0` on a dedicated one. RPC choice is the
single biggest lever on how fast a backfill catches up.

**Agents auto-list — `OCULOPUS_AGENT_IDS` is optional.** Any provider is added to the
directory the moment one of its receipts verifies; the node resolves the agentId from
the IdentityRegistry itself. `OCULOPUS_AGENT_IDS` only pins agents you want listed
before they have receipts (e.g. the seed demo agents). It always takes precedence and is
never overwritten by discovery.

**On `OCULOPUS_START_BLOCK`.** The RPC caps `eth_getLogs` at 1000 blocks per request, so
a full replay from the registry deployment is hundreds of requests. Pick deliberately:

- **Backfill everything** — omit it and let the node grind through history once. Progress
  persists to `data/state.json`, so it only pays this cost on first run.
- **Recent window only** — set it near the head. The node only ever sees receipts from
  that block onward; agents sit at the 25 prior until new receipts arrive. Fine for a
  demo, wrong for a directory people rely on.
- **Fast-forward a stuck backfill** — set it ABOVE the block already reached and restart.
  The node jumps `lastBlock` up to it (keeping everything indexed so far) and resumes, so
  a genesis backfill millions of blocks behind can skip straight to recent receipts. It
  only moves forward — a value at or below the current `lastBlock` is ignored.

Get the current head:

```bash
curl -s -X POST https://rpc.testnet.arc.network \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
```

## 4. systemd unit (all-in-one)

The simplest deployment — one process, everything. Good for a small node or a demo.

```bash
sudo tee /etc/systemd/system/oculopus.service >/dev/null <<'UNIT'
[Unit]
Description=Oculopus node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=oculopus
WorkingDirectory=/opt/oculopus/app
Environment=NODE_PORT=8790
Environment=OCULOPUS_RPC_URLS=https://rpc.testnet.arc.network
# Environment=OCULOPUS_START_BLOCK=55225000
ExecStart=/usr/bin/npx tsx src/node.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now oculopus
sudo systemctl status oculopus --no-pager
journalctl -u oculopus -f
```

Healthy startup looks like:

```
[identity] agent(s) verified against ERC-8004
Oculopus node → http://localhost:8790   (ERC-8004 identity 0x8004A818…, scanning from block …)
[role] reference
[indexer] verified receipt 0x67805a2b… 0x94dFD4→0x9aec41 success $0.002
[discover] listed 0x4a8cae… agentId 856655 — embedding
```

## 5. The two topologies — `OCULOPUS_ROLE`

One binary, three role values, **two ways to deploy**. The node is single-threaded (one
event loop), and the ERC-8183 job scan is heavy (full-network `getLogs` + per-job reads).
That one fact decides the topology.

### Topology A — all-in-one (`reference`, the default)

`npm run node` with no role = `reference`: it indexes receipts **and** jobs, scores, and
serves — all in the one event loop. Fine for **local dev, a demo, or a small node**.

> **Limit, stated plainly:** because the job scan runs in the same loop as head-follow, a
> heavy backfill makes the node lag head while it grinds through jobs. You saw this if you
> ran `reference` against a large history. For local/small use, set `OCULOPUS_START_BLOCK`
> near the head so there is little to backfill. For anything people rely on, use the split.

### Topology B — split: `indexer` + `worker` (production)

Two **separate processes** — so two event loops. The job scan in the worker process
physically cannot starve the indexer's head-follow. This is why the split works where
all-in-one lags, and it is what oculopus.xyz runs.

- **`indexer`** — light: syncs head, verifies receipts, lists agents, serves the directory
  + site + API. **Drops the ERC-8183 job scan**, so it always holds head on shared RPC.
- **`worker`** — heavy: carries the job scan + scoring, serves `/scores`. May lag head —
  fine, scores refresh in batches. Run it with a low `OCULOPUS_START_BLOCK` for full
  history.
- The indexer merges the worker's richer (job-inclusive) scores by setting
  `OCULOPUS_SCORER_URL` at the worker's `/scores` (last good scores are kept if the worker
  is briefly unreachable).

Both processes run happily **on one VPS** (two services below) — separate event loops is
what matters, not separate machines. Put the worker on its own box only when you want more
headroom. The npm scripts already wire the ports/state dirs:
`node:indexer` (8790, `data-indexer`) and `node:worker` (8792, `data-worker`).

```bash
# indexer service — serves the site + API, holds head
sudo tee /etc/systemd/system/oculopus.service >/dev/null <<'UNIT'
[Unit]
Description=Oculopus indexer
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=oculopus
WorkingDirectory=/opt/oculopus/app
Environment=OCULOPUS_ROLE=indexer
Environment=NODE_PORT=8790
Environment=OCULOPUS_STATE_DIR=data-indexer
Environment=OCULOPUS_RPC_URLS=https://rpc.testnet.arc.network
Environment=OCULOPUS_SCORER_URL=http://127.0.0.1:8792
ExecStart=/usr/bin/npx tsx src/node.ts
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT

# worker service — heavy job scan + scoring, serves /scores
sudo tee /etc/systemd/system/oculopus-worker.service >/dev/null <<'UNIT'
[Unit]
Description=Oculopus worker
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=oculopus
WorkingDirectory=/opt/oculopus/app
Environment=OCULOPUS_ROLE=worker
Environment=NODE_PORT=8792
Environment=OCULOPUS_STATE_DIR=data-worker
Environment=OCULOPUS_RPC_URLS=https://rpc.testnet.arc.network
ExecStart=/usr/bin/npx tsx src/node.ts
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now oculopus oculopus-worker
```

> A worker verifies a receipt only if it holds that receipt's off-chain document (documents
> are POSTed to a node, not gossiped yet — see Known limits), so a worker's history is only
> as complete as the documents it has.

## 6. Reverse proxy and TLS

**The node binds `127.0.0.1` only** — not reachable from outside without a proxy, by
design. The block below proxies the site/API (8790) and, if you run the oracle (§7), its
`/oracle/` routes (8791). Keep the `/oracle/` block **before** `location /`.

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo tee /etc/nginx/sites-available/oculopus >/dev/null <<'CONF'
server {
    server_name api.oculopus.xyz;

    # paid oracle + dashboard account API (§7) — before location /
    location /oracle/ {
        proxy_pass http://127.0.0.1:8791;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:8790;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
CONF
sudo ln -sf /etc/nginx/sites-available/oculopus /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.oculopus.xyz
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw --force enable
```

Point an A record for `api.oculopus.xyz` at the VPS before running certbot.

> **certbot gotcha.** `certbot --nginx -d <newdomain>` attaches the domain to nginx's
> *default* server block, so the API starts returning the default 404 page (0 agents).
> Fix: put the domain in the `oculopus` block's `server_name` (proxying 8790) and remove
> it from the default block, then `sudo systemctl reload nginx`.

## 7. The paid oracle + developer dashboard

Optional, and separate from the node. The oracle is a thin, stateless paywall over the
node's free score: an agent pays a fraction of a cent in USDC over x402 / Circle Gateway
and gets a standardized credit tier — the agent-native read. It also hosts the developer
dashboard (wallet sign-in + API keys).

**One-time: a Circle treasury wallet** (developer-controlled) to receive oracle revenue.
This is the only part that touches Circle credentials — keep the entity secret in `.env`,
never in a unit file, never in git.

```bash
npm run circle:gen        # generate + print the entity secret (store it safely)
npm run circle:register   # register it with Circle (needs CIRCLE_API_KEY)
npm run circle:wallet     # create the treasury wallet → prints OCULOPUS_TREASURY_ADDRESS
```

**Oracle service:**

```bash
sudo tee /etc/systemd/system/oculopus-oracle.service >/dev/null <<'UNIT'
[Unit]
Description=Oculopus paid oracle
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=oculopus
WorkingDirectory=/opt/oculopus/app
Environment=ORACLE_PORT=8791
Environment=ORACLE_UPSTREAM=http://127.0.0.1:8790
Environment=OCULOPUS_TREASURY_ADDRESS=0x<your-treasury-address>
Environment=ORACLE_SESSION_SECRET=<openssl rand -hex 32>
ExecStart=/usr/bin/npx tsx src/oracle.ts
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload && sudo systemctl enable --now oculopus-oracle
```

Oracle env: `ORACLE_PORT` (8791), `ORACLE_UPSTREAM` (the indexer, for the score),
`OCULOPUS_TREASURY_ADDRESS` (payTo — the only Circle value the oracle needs at runtime),
`ORACLE_PRICE` (default `$0.0001`), `ORACLE_SESSION_SECRET` (HMAC secret for dashboard
sessions — set it so sign-ins survive restarts), `ORACLE_FREE_LIMIT` (default 10000).

- Paid read: `GET https://api.oculopus.xyz/oracle/:addr` → 402 with payment requirements
  when unpaid, `{address, score, creditTier, asOf}` when paid.
- Dashboard: `https://oculopus.xyz/api` — MetaMask sign-in (SIWE), then create / list /
  revoke API keys and watch usage. Account API is under `/oracle/account/*`.

### Free tier and abuse

- A valid **API key with monthly quota left** bypasses x402 (free). **Keyless callers pay
  per call** over x402 — there is no free keyless read. Keys are minted only after a
  wallet signs in (SIWE), so minting is authenticated.
- Quota is **per wallet**, shared across all that wallet's keys — minting extra keys does
  not multiply the free allowance. Keys are 144-bit random and unique; collision/guessing
  is not a practical concern. `ORACLE_SESSION_SECRET` is a signing secret, **not** a call
  credential — it grants no calls.
- **Open hole (documented, low-stakes on testnet):** free is per *wallet*, and wallets are
  free to create, so a Sybil could farm free reads across many wallets. On testnet this
  only buys reads of public scores — no real cost — so it is not urgent.
- **Planned mitigation — reputation-gated free tier.** Unlock the full 10k/month only for
  wallets that are a *registered, scored agent above a threshold* (e.g. BRONZE+); give any
  other signed-in wallet a small trial; everyone else pays per call. This makes abuse-scale
  free require real on-chain participation, and dogfoods the score itself. Not yet
  implemented.

## 8. Seeding a demo network

All seeding runs from a machine holding a **funded** `BUYER_PRIVATE_KEY` in `.env` (Arc
testnet USDC). It is not part of the node and never runs on the node's behalf.

```bash
# point seeding at your node (defaults to the LIVE api.oculopus.xyz — override for local!)
OC_NODE_URL=http://localhost:8790 npm run seed          # N provider agents + on-chain receipts
OC_NODE_URL=http://localhost:8790 npm run seed:x402     # x402-rail receipts (co-signed + Merkle-anchored)
npm run oracle                                          # start the oracle locally
ORACLE_URL=http://localhost:8791 npm run agent:creditcheck -- 0x<addr>   # autonomous buyer pays + decides
```

> **`OC_NODE_URL` defaults to the LIVE node.** Run a local demo without setting it and you
> will seed production. Always set `OC_NODE_URL=http://localhost:8790` for local work.
> `seed:x402` anchors one real Merkle root on Arc (needs gas); its receipts' signatures and
> anchor are real, only Circle's `settlementId` is synthetic on testnet.

## 9. Check it

```bash
curl -s https://api.oculopus.xyz/directory | grep -o '"address"' | wc -l   # agents listed
curl -s https://api.oculopus.xyz/x402/receipts                             # x402-rail total/scored
curl -s https://api.oculopus.xyz/agents/0x9aec413ff42858eaf080af688b9a858396af1174
```

If a provider you expect is missing, it is almost always index position, not the
directory: the node has not scanned the block its receipt was anchored in yet:

```bash
sudo -u oculopus node -e "const s=require('/opt/oculopus/app/data-indexer/state.json'); console.log('lastBlock', s.lastBlock, '| receipts', Object.keys(s.receipts).length, '| agents', Object.keys(s.agents).length);"
```

The node also serves the site, so `https://api.oculopus.xyz/` is the full product with
same-origin live data. The hosted app lives at `https://oculopus.xyz`.

## 10. Upgrades and state

```bash
cd /opt/oculopus/app
sudo -u oculopus git pull && sudo -u oculopus npm install   # npm install only if deps changed
sudo systemctl restart oculopus            # + oculopus-worker / oculopus-oracle if running
```

> **`git pull` fails with "divergent branches"?** If the repo history was ever rewritten,
> a checkout can diverge. Reset to origin — `.env`, `data*/` and `node_modules` are
> gitignored, so they survive: `git fetch origin && git reset --hard origin/main`.

`data*/` is derived state: `state.json` (scan working set + progress) and `oculopus.db`
(the SQLite store). Deleting it forces a re-index from `OCULOPUS_START_BLOCK`; chain-derived
parts rebuild losslessly. The only things NOT from chain are the off-chain receipt
documents (re-derived only if re-POSTed — see Known limits).

## Known limits

- **Receipt documents live off-chain.** The chain stores the hash; the document is POSTed
  to a node. If no node has a given receipt, its hash is still on-chain and still
  verifiable as a payment, but its contents cannot be read. Receipts are not yet gossiped
  between nodes — one node is one node's view.
- **`reference` lags under heavy backfill** (§5) — the job scan shares the event loop with
  head-follow. Use the split (`indexer` + `worker`) for anything beyond dev/small.
- **Job rail depends on real ERC-8183 jobs.** The worker indexes escrowed jobs, but only
  jobs that actually exist on chain. Oculopus reads 8183; it does not create escrow.
- **Directory membership is earned, not scanned.** A provider auto-lists once one of its
  receipts verifies — the directory is exactly the agents with real Oculopus activity, not
  the 850k+ agents on testnet.
- **Single RPC dependency.** The node falls back across `OCULOPUS_RPC_URLS` then the
  official Arc RPC then a public one; all being down (or rate-limited) stalls indexing. It
  resumes from `state.json`.
