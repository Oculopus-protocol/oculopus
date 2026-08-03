# Running an Oculopus node on Ubuntu

An Oculopus node is a read-only indexer. It watches Arc for Memo-anchored receipts,
verifies them, scores agents, serves the directory API, and hosts the site.

**It holds no private key.** Nothing it does costs money and nothing it stores can
move funds — agents sign and pay for themselves. Treat a node compromise as a data
integrity problem, not a loss-of-funds problem.

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

Verify the install before going further:

```bash
sudo -u oculopus npm test        # 61/61
sudo -u oculopus npx tsc --noEmit
```

## 3. Configure

The node needs no `.env` and no key. Two variables matter:

| Variable | Purpose |
|---|---|
| `OCULOPUS_AGENT_IDS` | Comma-separated ERC-8004 agentIds to pin. Owner, URI and endpoint are read from the registry — nothing is trusted from disk. |
| `OCULOPUS_START_BLOCK` | Block to begin indexing from, and a fast-forward floor on an existing index (see below). |

Optional: `NODE_PORT` (default 8790), `OCULOPUS_STATE_DIR` (default `data`),
`OCULOPUS_DB` (default `<state-dir>/oculopus.db`, the SQLite store),
`WITNESS_ADDRESSES` (comma-separated gateway addresses whose receipts weigh ×3),
`OCULOPUS_RPC_URLS` (see below), `OCULOPUS_ROLE` / `OCULOPUS_SCORER_URL` (see below).

**Use a keyed RPC — the public ones will stall you.** Both default endpoints
(`rpc.testnet.arc.network` and the unkeyed thirdweb) return HTTP 429 under the load of
a backfill, and the node crawls: verifying receipts and reading feedback each cost an
RPC call, and a rate-limited endpoint turns minutes into hours. Get a free thirdweb
client id (<https://thirdweb.com/create-api-key>) and set it first, public ones stay as
fallback:

```
Environment=OCULOPUS_RPC_URLS=https://5042002.rpc.thirdweb.com/<CLIENT_ID>
```

Comma-separate to list several. This is the single biggest lever on how fast the index
catches up.

**`OCULOPUS_ROLE` — split the load across a fleet.** One binary, three roles chosen by
config, so a deployment scales from a single box to many without code changes:

- `reference` (default) — do everything and serve. Right for one node.
- `indexer` — sync head, validate receipts, list agents, serve the directory, but
  **skip the heavy full-network ERC-8183 job scan**. Stays light enough to hold head on
  shared RPC. (Named `indexer`, not `validator`, to avoid confusion with Arc's
  consensus validators.)
- `worker` — carry the job scan and scoring. Heavier; run it on a bigger box. It may lag
  head, which is fine — scores refresh in batches, they do not need to be real-time.

An indexer scores from receipts and feedback alone; to fill in job-derived scores, point
it at a worker with `OCULOPUS_SCORER_URL=https://<worker-host>` — it fetches that worker's
`/scores` and merges them into its directory (last good scores are kept if the worker is
briefly unreachable). A worker serves `/scores` from its full data; run it with a low
`OCULOPUS_START_BLOCK` for full history. Run several `indexer` nodes behind a load
balancer, and one or two `worker` nodes for the heavy rail.

**Agents auto-list — `OCULOPUS_AGENT_IDS` is optional.** Any provider is added to the
directory the moment one of its receipts verifies; the node resolves the agentId from
the IdentityRegistry itself. `OCULOPUS_AGENT_IDS` only pins agents you want listed
before they have receipts (e.g. the seed demo trio). It always takes precedence and is
never overwritten by discovery.

**On `OCULOPUS_START_BLOCK`.** The RPC caps `eth_getLogs` at 1000 blocks per
request, so a full replay from the registry deployment is hundreds of requests and
takes a long while. Pick deliberately:

- **Backfill everything** — omit it and let the node grind through history once. It
  persists progress to `data/state.json`, so it only pays this cost on first run.
- **Recent window only** — set it near the head. The node will only ever see
  receipts from that block onward, and agents will sit at the 25 prior until new
  receipts arrive. Fine for a demo, wrong for a directory people rely on.
- **Fast-forward a stuck backfill** — set it ABOVE the block already reached and
  restart. The node jumps `lastBlock` up to it (keeping everything indexed so far) and
  resumes from there, so a genesis backfill that is millions of blocks behind can skip
  straight to where recent receipts are. It only moves forward — a value at or below
  the current `lastBlock` is ignored, so it never rewinds or re-scans.

Get the current head:

```bash
curl -s -X POST https://rpc.testnet.arc.network \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
```

## 4. systemd unit

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
Environment=OCULOPUS_AGENT_IDS=851356,851357,851358
# Environment=OCULOPUS_START_BLOCK=52560000
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
[identity] 3 agent(s) verified against ERC-8004
[discover] back-filled 25 agent(s) from verified receipts on disk
Oculopus node → http://localhost:8790   (ERC-8004 identity 0x8004A818…, scanning from block …)
[role] reference
[indexer] verified receipt 0x67805a2b… 0x94dFD4→0x9aec41 success $0.002
[discover] listed 0x4a8cae… agentId 856655 — embedding
```

### Running the three roles

The unit above is a **reference** node (does everything) — right for a single box. For a
fleet, set `OCULOPUS_ROLE` and split the work:

- **`reference`** (default): indexes receipts + jobs, scores, and serves. One node.
- **`indexer`** — light, holds head, serves the directory. Add
  `Environment=OCULOPUS_ROLE=indexer`, keep `OCULOPUS_START_BLOCK` near the head, and to
  show job-derived scores add `Environment=OCULOPUS_SCORER_URL=https://<worker-host>`.
  Run several behind a load balancer for redundancy.
- **`worker`** — heavy, carries the job scan + scoring. Add
  `Environment=OCULOPUS_ROLE=worker` and a **low** `OCULOPUS_START_BLOCK` for full
  history; run it on a bigger box (more RAM, NVMe). It may lag head — fine — and serves
  `/scores`, which indexers fetch and merge.

A worker verifies a receipt only if it holds that receipt's off-chain document (documents
are POSTed to a node, not gossiped yet — see Known limits), so a worker's history is only
as complete as the documents it has.

## 5. Reverse proxy and TLS

**The node binds `127.0.0.1` only.** It is not reachable from outside the box
without a proxy — that is deliberate, not an oversight.

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo tee /etc/nginx/sites-available/oculopus >/dev/null <<'CONF'
server {
    server_name node.oculopus.xyz;
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
sudo certbot --nginx -d node.oculopus.xyz
```

Firewall:

```bash
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw --force enable
```

Point an A record for `node.oculopus.xyz` at the VPS before running certbot.

## 6. Check it

```bash
curl -s https://node.oculopus.xyz/directory | grep -o '"address"' | wc -l   # how many agents listed
curl -s https://node.oculopus.xyz/directory | head -40
curl -s https://node.oculopus.xyz/agents/0x9aec413ff42858eaf080af688b9a858396af1174
```

If a provider you expect is missing, it is almost always the index position, not the
directory: the node has not scanned the block its receipt was anchored in yet. Check
how far behind it is, and fast-forward if the gap is large:

```bash
sudo -u oculopus node -e "const s=require('/opt/oculopus/app/data/state.json'); console.log('lastBlock', s.lastBlock, '| receipts', Object.keys(s.receipts).length, '| verified', Object.values(s.receipts).filter(r=>r.verified).length, '| agents', Object.keys(s.agents).length);"
```

Each directory entry carries both scores:

```json
{
  "agentId": "851356",
  "erc8004": { "clients": 1, "feedback": 22, "rawScore": 54.5 },
  "score": 46.4
}
```

Then connect the hosted dashboard to it:

```
https://www.oculopus.xyz/dashboard?api=https://node.oculopus.xyz
```

The node also serves the site itself, so `https://node.oculopus.xyz/` is the full
product with same-origin live data and no `?api=` needed.

## 7. Upgrades and state

```bash
cd /opt/oculopus/app
sudo -u oculopus git pull && sudo -u oculopus npm install
sudo systemctl restart oculopus
```

`data/` is derived state: `state.json` (scan working set + index progress) and
`oculopus.db` (the SQLite store — via better-sqlite3, the queryable source the directory
and scores are served from; override the path with `OCULOPUS_DB`). Deleting `data/`
forces a re-index from `OCULOPUS_START_BLOCK`. The chain-derived parts rebuild losslessly;
the only things NOT from chain are the off-chain receipt documents (re-derived only if
re-POSTed — see Known limits) and `data/identities.json` (a convenience that
`OCULOPUS_AGENT_IDS` covers from chain data).

## Known limits

- **Receipt documents live off-chain.** The chain stores the hash; the document is
  POSTed to a node. If no node has a given receipt, its hash is still on-chain and
  still verifiable as a payment, but its contents cannot be read. Receipts are not
  yet gossiped between nodes — one node is one node's view.
- **Directory membership is earned, not scanned.** A provider auto-lists once one of
  its receipts verifies — so the directory is exactly the set of agents with real
  Oculopus activity, not the 850k+ agents registered on testnet (an unfiltered scan of
  those is not practical). `OCULOPUS_AGENT_IDS` still pins agents ahead of their first
  receipt and takes precedence.
- **Single RPC dependency.** The node falls back across `OCULOPUS_RPC_URLS` then the
  official Arc RPC then a public one, but all being down (or all rate-limited) stalls
  indexing. It resumes from `state.json`.
